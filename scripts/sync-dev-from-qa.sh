#!/usr/bin/env bash
# ============================================================
# sync-dev-from-qa.sh
# Re-baseline the suppliable-dev Firebase project from suppliable-qa-723f2.
#
# Syncs:
#   - Firestore catalog collections (products, categories, banners, shades,
#     paintPricing, config) plus the `colours` subcollection under shades/.
#   - Cloud Storage objects under banners/, categories/, products/.
#
# Does NOT sync:
#   - PII/order collections (customers, orders, addresses, carts, invoices,
#     drivers, vehicles, codHandovers, fcmTokens, idempotency_keys).
#   - Storage `deliveries/` (driver proof photos tied to skipped orders).
#   - Realtime DB `liveOrders` data (operational state).
#   - Remote Config (re-publish rc-dev.json manually via console when needed).
#   - Firebase Auth users.
#
# Rules / indexes are deployed separately with `firebase deploy --project dev`.
#
# Usage:
#   ./sync-dev-from-qa.sh           # upsert (existing dev docs survive)
#   ./sync-dev-from-qa.sh --wipe    # delete catalog collections in dev first
#                                   # (true mirror; loses dev-only tweaks)
# ============================================================
set -euo pipefail

QA_PROJECT="suppliable-qa-723f2"
DEV_PROJECT="suppliable-dev"
STAGING_BUCKET="gs://suppliable-dev-firestore-imports"
QA_STORAGE_BUCKET="gs://suppliable-qa-723f2.firebasestorage.app"
DEV_STORAGE_BUCKET="gs://suppliable-dev.firebasestorage.app"

PARENT_COLLECTIONS="products,categories,banners,shades,paintPricing,config"
SUB_COLLECTIONS="colours"
STORAGE_PREFIXES=("banners" "categories" "products")

WIPE=false
for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=true ;;
    -h|--help)
      sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] %s\n' "$(ts)" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$(ts)" "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
log "Preflight: confirming projects and tools"
command -v gcloud >/dev/null || fail "gcloud not on PATH"
command -v gsutil >/dev/null || fail "gsutil not on PATH"
command -v python3 >/dev/null || fail "python3 not on PATH"

gcloud projects describe "$QA_PROJECT" --format='value(projectId)' >/dev/null \
  || fail "Cannot access $QA_PROJECT — check gcloud auth"
gcloud projects describe "$DEV_PROJECT" --format='value(projectId)' >/dev/null \
  || fail "Cannot access $DEV_PROJECT — check gcloud auth"

# Staging bucket (idempotent: create if missing)
if ! gsutil ls -b "$STAGING_BUCKET" >/dev/null 2>&1; then
  log "Staging bucket $STAGING_BUCKET missing — creating in asia-south1"
  gsutil mb -p "$DEV_PROJECT" -l asia-south1 -b on "$STAGING_BUCKET"
fi

# IAM grants for Firestore service agents (idempotent)
QA_PROJ_NUM=$(gcloud projects describe "$QA_PROJECT"  --format='value(projectNumber)')
DEV_PROJ_NUM=$(gcloud projects describe "$DEV_PROJECT" --format='value(projectNumber)')
QA_SA="service-${QA_PROJ_NUM}@gcp-sa-firestore.iam.gserviceaccount.com"
DEV_SA="service-${DEV_PROJ_NUM}@gcp-sa-firestore.iam.gserviceaccount.com"
gsutil iam ch "serviceAccount:${QA_SA}:admin"        "$STAGING_BUCKET" >/dev/null
gsutil iam ch "serviceAccount:${DEV_SA}:objectViewer" "$STAGING_BUCKET" >/dev/null

# ── Helpers ──────────────────────────────────────────────────────────────────
# Poll a Firestore admin operation until done. Args: project, uri-substring, label
wait_for_op() {
  local proj="$1" uri="$2" label="$3"
  log "Waiting for $label to finish…"
  while true; do
    local state
    state=$(gcloud firestore operations list --project="$proj" --format=json 2>/dev/null \
      | python3 -c "
import json,sys
ops=json.load(sys.stdin)
m=[o for o in ops if '$uri' in (o.get('metadata',{}).get('outputUriPrefix','') + o.get('metadata',{}).get('inputUriPrefix',''))]
if not m:
    print('PENDING')
elif m[0].get('done'):
    print(m[0].get('metadata',{}).get('operationState','UNKNOWN'))
else:
    print('PENDING')
") || fail "Failed to query $label state"
    case "$state" in
      SUCCESSFUL) log "$label: $state"; return 0 ;;
      FAILED|CANCELLED) fail "$label ended in state $state" ;;
      *) sleep 5 ;;
    esac
  done
}

# REST aggregation count for a (sub)collection. Args: project, collection, [allDescendants=true|false]
count_collection() {
  local proj="$1" col="$2" desc="${3:-false}"
  local token
  token=$(gcloud auth print-access-token)
  curl -s -X POST \
    "https://firestore.googleapis.com/v1/projects/${proj}/databases/(default)/documents:runAggregationQuery" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    -d "{\"structuredAggregationQuery\":{\"structuredQuery\":{\"from\":[{\"collectionId\":\"$col\",\"allDescendants\":$desc}]},\"aggregations\":[{\"count\":{}}]}}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['result']['aggregateFields']['field_1']['integerValue'])" 2>/dev/null \
    || echo "?"
}

# ── Optional: wipe dev catalog ───────────────────────────────────────────────
if [ "$WIPE" = true ]; then
  log "WIPE enabled — deleting dev catalog collections (recursive, force)"
  for col in $(echo "$PARENT_COLLECTIONS" | tr ',' ' '); do
    log "  delete $col"
    firebase firestore:delete --project "$DEV_PROJECT" --recursive --force "$col" >/dev/null
  done
fi

# ── Step 1: Export catalog from QA ───────────────────────────────────────────
SNAPSHOT="qa-snapshot-$(date +%Y%m%d-%H%M%S)"
SHADES_SNAPSHOT="${SNAPSHOT}-colours"
log "Exporting parent collections from QA → $STAGING_BUCKET/$SNAPSHOT"
gcloud firestore export "$STAGING_BUCKET/$SNAPSHOT" \
  --collection-ids="$PARENT_COLLECTIONS" \
  --project="$QA_PROJECT" --async >/dev/null
wait_for_op "$QA_PROJECT" "$SNAPSHOT" "parent export"

log "Exporting subcollection 'colours' from QA → $STAGING_BUCKET/$SHADES_SNAPSHOT"
# Subcollections need their own export pass — `--collection-ids` does NOT
# include nested collections automatically.
gcloud firestore export "$STAGING_BUCKET/$SHADES_SNAPSHOT" \
  --collection-ids="$SUB_COLLECTIONS" \
  --project="$QA_PROJECT" --async >/dev/null
wait_for_op "$QA_PROJECT" "$SHADES_SNAPSHOT" "colours export"

# ── Step 2: Import into dev ──────────────────────────────────────────────────
log "Importing parent collections into $DEV_PROJECT"
gcloud firestore import "$STAGING_BUCKET/$SNAPSHOT" \
  --collection-ids="$PARENT_COLLECTIONS" \
  --project="$DEV_PROJECT" --async >/dev/null
wait_for_op "$DEV_PROJECT" "$SNAPSHOT" "parent import"

log "Importing colours subcollection into $DEV_PROJECT"
gcloud firestore import "$STAGING_BUCKET/$SHADES_SNAPSHOT" \
  --collection-ids="$SUB_COLLECTIONS" \
  --project="$DEV_PROJECT" --async >/dev/null
wait_for_op "$DEV_PROJECT" "$SHADES_SNAPSHOT" "colours import"

# ── Step 3: Storage rsync ────────────────────────────────────────────────────
for prefix in "${STORAGE_PREFIXES[@]}"; do
  log "Storage rsync: $prefix/"
  gsutil -m rsync -r -d \
    "$QA_STORAGE_BUCKET/$prefix/" \
    "$DEV_STORAGE_BUCKET/$prefix/" 2>&1 | tail -3
done

# rsync copies content but NOT per-object ACLs. QA grants AllUsers:R on each
# image (matching what the admin upload flow does). Mirror that on the dev
# bucket so https://storage.googleapis.com/...png URLs render anonymously.
log "Granting AllUsers:R on dev bucket objects (idempotent)"
gsutil -m acl ch -u AllUsers:R -r "$DEV_STORAGE_BUCKET" 2>&1 | tail -3
gsutil defacl ch -u AllUsers:R "$DEV_STORAGE_BUCKET" >/dev/null

# ── Step 4: Rewrite hardcoded source-bucket URLs in dev Firestore ────────────
# Catalog docs (banners, categories, products, config) carry absolute imageUrl
# fields like https://storage.googleapis.com/<source>.firebasestorage.app/...
# After import these still point at the source project. Rewrite to dev bucket.
log "Rewriting source-bucket URLs in dev Firestore"
( cd "$(dirname "$0")/.." && node scripts/rewrite-image-urls.js --apply ) 2>&1 | tail -15

# ── Step 5: Verify ───────────────────────────────────────────────────────────
log "Verifying counts (qa vs dev)"
printf '%-15s %10s %10s\n' "collection" "qa" "dev"
for col in $(echo "$PARENT_COLLECTIONS" | tr ',' ' '); do
  printf '%-15s %10s %10s\n' "$col" "$(count_collection "$QA_PROJECT" "$col")" "$(count_collection "$DEV_PROJECT" "$col")"
done
printf '%-15s %10s %10s\n' "colours (CG)" \
  "$(count_collection "$QA_PROJECT" colours true)" \
  "$(count_collection "$DEV_PROJECT" colours true)"

log "Storage size:"
gsutil du -sh "$DEV_STORAGE_BUCKET" 2>/dev/null | sed 's/^/  /'

log "Done. Snapshot kept at $STAGING_BUCKET/$SNAPSHOT (and ${SHADES_SNAPSHOT})."
log "If you want to delete old snapshots: gsutil -m rm -r $STAGING_BUCKET/qa-snapshot-YYYYMMDD-*"
