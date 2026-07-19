#!/usr/bin/env bash
# deploy.sh — Build and deploy construction-api to Google Cloud Run
# Usage: ./deploy.sh
# Prerequisites: gcloud CLI installed and authenticated

set -euo pipefail

# ── CONFIG (edit these) ──────────────────────────────────────────────────────
PROJECT_ID="suppliable-app"
REGION="asia-south1"   # Mumbai — closest to your warehouse location
SERVICE_NAME="construction-api"
REPO_NAME="suppliable"
IMAGES_TO_KEEP=3       # number of recent Docker images to retain
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── Validate config ───────────────────────────────────────────────────────────
[[ -z "$PROJECT_ID" ]] && error "Set PROJECT_ID at the top of this script"
[[ ! -f ".env.local" ]] && error ".env.local not found — copy .env.template and fill it in"

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v gcloud >/dev/null || error "gcloud CLI not found. Install: brew install --cask google-cloud-sdk"

info "Using project: $PROJECT_ID  region: $REGION"
gcloud config set project "$PROJECT_ID"

# ── Enable required APIs ──────────────────────────────────────────────────────
info "Enabling required GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  --project "$PROJECT_ID"

# ── Artifact Registry ─────────────────────────────────────────────────────────
AR_HOST="${REGION}-docker.pkg.dev"
IMAGE_PATH="${AR_HOST}/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"

if ! gcloud artifacts repositories describe "$REPO_NAME" \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  info "Creating Artifact Registry repository: $REPO_NAME"
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID"
fi

gcloud auth configure-docker "$AR_HOST" --quiet

# ── Build & push image ────────────────────────────────────────────────────────
IMAGE_TAG="${IMAGE_PATH}:$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
info "Building Docker image via Cloud Build: $IMAGE_TAG"
gcloud builds submit \
  --tag "$IMAGE_TAG" \
  --project "$PROJECT_ID" \
  .
info "Image built and pushed: $IMAGE_TAG"

# ── Cleanup old Docker images (keep last N) ───────────────────────────────────
# Prevents hitting the 0.5 GB free tier limit in Artifact Registry
info "Cleaning up old Docker images (keeping last $IMAGES_TO_KEEP)..."
OLD_IMAGES=$(gcloud artifacts docker images list "$IMAGE_PATH" \
  --project="$PROJECT_ID" \
  --sort-by="~CREATE_TIME" \
  --format="value(version)" 2>/dev/null | tail -n +$((IMAGES_TO_KEEP + 1)) || true)

if [[ -n "$OLD_IMAGES" ]]; then
  while IFS= read -r digest; do
    gcloud artifacts docker images delete "${IMAGE_PATH}@${digest}" \
      --quiet --delete-tags --project="$PROJECT_ID" 2>/dev/null && \
      info "  deleted old image: ${digest:0:20}..." || true
  done <<< "$OLD_IMAGES"
else
  info "  no old images to clean up"
fi

# ── Secrets in Secret Manager ─────────────────────────────────────────────────
# These env vars are loaded from .env.local and stored as Secret Manager secrets.
# Each secret is mounted as an env var in Cloud Run.
# NOTE: FIREBASE_SERVICE_ACCOUNT must be base64-encoded in .env.local:
#   base64 -i your-firebase-key.json | tr -d '\n'
# In your Node.js app decode it with:
#   JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString())
REQUIRED_SECRETS=(
  ZOHO_CLIENT_ID
  ZOHO_CLIENT_SECRET
  ZOHO_REFRESH_TOKEN
  ZOHO_ORG_ID
  FIREBASE_SERVICE_ACCOUNT
  ADMIN_PASSWORD
  ADMIN_TOKEN
  JWT_SECRET
)
OPTIONAL_SECRETS=(
  ZOHO_API_DOMAIN
  GOOGLE_MAPS_API_KEY
  WAREHOUSE_LAT
  WAREHOUSE_LNG
  CLOUDINARY_CLOUD_NAME
  CLOUDINARY_API_KEY
  CLOUDINARY_API_SECRET
  GRAFANA_USER
  GRAFANA_API_KEY
  OTLP_ENDPOINT
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
)

upsert_secret() {
  local name="$1" value="$2"
  # lowercase and replace underscores with hyphens for secret ID
  local secret_id
  secret_id=$(echo "${SERVICE_NAME}-${name}" | tr '[:upper:]' '[:lower:]' | tr '_' '-')

  if gcloud secrets describe "$secret_id" --project="$PROJECT_ID" &>/dev/null; then
    printf '%s' "$value" | gcloud secrets versions add "$secret_id" \
      --data-file=- --project="$PROJECT_ID" >/dev/null
    info "  updated secret: $secret_id" >&2

    # ── Destroy all old ENABLED versions except the latest ────────────────────
    # Keeps secret versions within the free tier limit (6 active versions total)
    OLD_VERSIONS=$(gcloud secrets versions list "$secret_id" \
      --project="$PROJECT_ID" \
      --filter="state=ENABLED" \
      --sort-by="~createTime" \
      --format="value(name)" 2>/dev/null | tail -n +2 || true)

    if [[ -n "$OLD_VERSIONS" ]]; then
      while IFS= read -r ver; do
        gcloud secrets versions destroy "$ver" \
          --secret="$secret_id" --project="$PROJECT_ID" --quiet 2>/dev/null && \
          info "  destroyed old version: $ver" >&2 || true
      done <<< "$OLD_VERSIONS"
    fi
  else
    printf '%s' "$value" | gcloud secrets create "$secret_id" \
      --data-file=- --replication-policy=automatic --project="$PROJECT_ID" >/dev/null
    info "  created secret: $secret_id" >&2
  fi
  echo "$secret_id"
}

get_env_val() {
  local key="$1"
  # Handles values with '=' signs (e.g. base64 encoded JSON)
  grep -E "^${key}=" .env.local | head -1 | cut -d'=' -f2-
}

info "Syncing secrets to Secret Manager..."
SECRET_PAIRS=""   # comma-separated KEY=secret-id:latest list

for key in "${REQUIRED_SECRETS[@]}"; do
  val=$(get_env_val "$key")
  [[ -z "$val" ]] && error "Required secret $key is empty in .env.local"
  sid=$(upsert_secret "$key" "$val")
  SECRET_PAIRS="${SECRET_PAIRS:+$SECRET_PAIRS,}${key}=${sid}:latest"
done

for key in "${OPTIONAL_SECRETS[@]}"; do
  val=$(get_env_val "$key")
  [[ -z "$val" ]] && continue
  sid=$(upsert_secret "$key" "$val")
  SECRET_PAIRS="${SECRET_PAIRS:+$SECRET_PAIRS,}${key}=${sid}:latest"
done

# ── Scheduler service account ─────────────────────────────────────────────────
# Created BEFORE the deploy so its email can be injected as an env var in the
# same rollout — otherwise the tick endpoint would sit closed until a second
# deploy. The email is derived from PROJECT_ID, so it's known ahead of creation.
SCHEDULER_SA="warehouse-scheduler"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SCHEDULER_SA_EMAIL" --project "$PROJECT_ID" &>/dev/null; then
  info "Creating service account $SCHEDULER_SA_EMAIL"
  gcloud iam service-accounts create "$SCHEDULER_SA" \
    --display-name "Warehouse schedule tick (Cloud Scheduler)" \
    --project "$PROJECT_ID"
else
  info "Scheduler service account already exists"
fi

# ── Deploy to Cloud Run ───────────────────────────────────────────────────────
info "Deploying to Cloud Run..."
# The scheduler SA email is public identity metadata, not a credential, so it
# goes in --set-env-vars rather than Secret Manager (which is version-capped).
# shellcheck disable=SC2086
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE_TAG" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 3000 \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 80 \
  --timeout 60 \
  --set-env-vars NODE_ENV=production,SCHEDULER_SERVICE_ACCOUNT_EMAIL="$SCHEDULER_SA_EMAIL" \
  --set-secrets="$SECRET_PAIRS" \
  --project "$PROJECT_ID"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format "value(status.url)")

# ── Cloud Scheduler: warehouse open/close announcements (PROD ONLY) ───────────
# This script deploys prod only (PROJECT_ID is hardcoded to suppliable-app), and
# Cloud Scheduler jobs are scoped to that GCP project — so these two jobs exist
# for prod alone. Dev and qa run on Render, which no cron reaches, and so get no
# scheduled announcements. That is fine: the open/closed gate is computed from
# the clock on every request, so dev/qa still honour the schedule exactly. Only
# the Slack notice is prod-only. Manual admin closes announce from every env,
# since those fire inline on the admin request rather than via cron.
#
# These jobs only POST a tick so the API can announce a schedule transition to
# Slack. They do NOT open or close the warehouse — so a missed firing costs a
# notification, not uptime.
# Safe to re-run: create falls back to update. The service account itself is
# created earlier, before the deploy, so its email can be passed as an env var.
TICK_URL="${SERVICE_URL}/api/v1/config/warehouse-schedule-tick"

info "Configuring Cloud Scheduler jobs..."

# The scheduler SA needs to invoke the Cloud Run service.
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --member "serviceAccount:${SCHEDULER_SA_EMAIL}" \
  --role roles/run.invoker \
  --region "$REGION" --project "$PROJECT_ID" >/dev/null

# One job per schedule boundary. Cron is in Asia/Kolkata to match the warehouse's
# local day; Mon–Sat only (1-6). Keep these in sync with the `warehouse_schedule`
# Remote Config key — the cron decides when we ANNOUNCE, the RC key decides when
# the store is actually open.
create_or_update_job() {
  local name="$1" cron="$2"
  if gcloud scheduler jobs describe "$name" --location "$REGION" --project "$PROJECT_ID" &>/dev/null; then
    gcloud scheduler jobs update http "$name" \
      --location "$REGION" --project "$PROJECT_ID" \
      --schedule "$cron" --time-zone "Asia/Kolkata" \
      --uri "$TICK_URL" --http-method POST \
      --oidc-service-account-email "$SCHEDULER_SA_EMAIL" \
      --oidc-token-audience "$SERVICE_URL" >/dev/null
    info "Updated scheduler job: $name ($cron IST)"
  else
    gcloud scheduler jobs create http "$name" \
      --location "$REGION" --project "$PROJECT_ID" \
      --schedule "$cron" --time-zone "Asia/Kolkata" \
      --uri "$TICK_URL" --http-method POST \
      --oidc-service-account-email "$SCHEDULER_SA_EMAIL" \
      --oidc-token-audience "$SERVICE_URL" >/dev/null
    info "Created scheduler job: $name ($cron IST)"
  fi
}

create_or_update_job "warehouse-open-tick"  "45 8 * * 1-6"
create_or_update_job "warehouse-close-tick" "30 19 * * 1-6"

# Prove the endpoint is wired up: unauthenticated callers must be rejected (401),
# never 503 (which would mean SCHEDULER_SERVICE_ACCOUNT_EMAIL didn't reach the
# container) and never 2xx (which would mean it's open to the world).
TICK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$TICK_URL" || true)
case "$TICK_STATUS" in
  401) info "Scheduler tick endpoint is live and rejecting unauthenticated callers ✅" ;;
  503) warn "Tick endpoint returned 503 — SCHEDULER_SERVICE_ACCOUNT_EMAIL is not reaching the container" ;;
  *)   warn "Tick endpoint returned unexpected HTTP $TICK_STATUS (expected 401)" ;;
esac

# ── Post-deploy health check ──────────────────────────────────────────────────
info "Deployed! Service URL: $SERVICE_URL"
info "Running health check..."
sleep 3
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL/" || true)
if [[ "$HTTP_STATUS" == "200" ]]; then
  info "Health check passed ✅ (HTTP $HTTP_STATUS)"
else
  warn "Health check returned HTTP $HTTP_STATUS — inspect logs with:"
  warn "gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME' --limit 20 --project $PROJECT_ID"
fi