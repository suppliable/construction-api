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

# ── Deploy to Cloud Run ───────────────────────────────────────────────────────
info "Deploying to Cloud Run..."
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
  --set-env-vars NODE_ENV=production \
  --set-secrets="$SECRET_PAIRS" \
  --project "$PROJECT_ID"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format "value(status.url)")

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