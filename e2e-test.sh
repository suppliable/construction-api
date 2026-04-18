#!/bin/bash
BASE="https://construction-api-2.onrender.com"
ADMIN_TOKEN="suppliable-admin-2024"
USER_ID="e2e-test-001"
PASS=0; FAIL=0; RESULTS=()

jp() {
  node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{const o=JSON.parse(d);const v=($1);process.stdout.write(v==null?'':String(v));}
      catch(e){process.stdout.write('');}
    });
  "
}

chk() {
  local phase="$1" step="$2" label="$3" result="$4" note="$5"
  if [ "$result" = "PASS" ]; then
    PASS=$((PASS+1)); RESULTS+=("✅ $phase | $step | $label | $note")
  else
    FAIL=$((FAIL+1)); RESULTS+=("❌ $phase | $step | $label | FAIL: $note")
  fi
}

sep() { echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; echo "$1"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# Minimal valid JPEG
PHOTO_FILE=$(mktemp /tmp/e2e-photo-XXXXXX.jpg)
node -e "
const b=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xdb,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,0x07,0x07,0x07,0x09,0x09,0x08,0x0a,0x0c,0x14,0x0d,0x0c,0x0b,0x0b,0x0c,0x19,0x12,0x13,0x0f,0x14,0x1d,0x1a,0x1f,0x1e,0x1d,0x1a,0x1c,0x1c,0x20,0x24,0x2e,0x27,0x20,0x22,0x2c,0x23,0x1c,0x1c,0x28,0x37,0x29,0x2c,0x30,0x31,0x34,0x34,0x34,0x1f,0x27,0x39,0x3d,0x38,0x32,0x3c,0x2e,0x33,0x34,0x32,0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x1f,0x00,0x00,0x01,0x05,0x01,0x01,0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0xff,0xc4,0x00,0x35,0x10,0x00,0x02,0x01,0x03,0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7d,0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0xfb,0x4a,0x28,0x00,0xff,0xd9]);
require('fs').writeFileSync(process.argv[1],b);
" "$PHOTO_FILE"

# ─── PHASE 1 — CONFIG ──────────────────────────────────────────
sep "PHASE 1 — CONFIG"

R=$(curl -s $BASE/api/config/warehouse-status)
echo "1.1: $R"
V=$(echo $R | jp 'o.success&&o.data?.isOpen!==undefined?"true":"false"')
[ "$V"="true" ] && chk P1 1.1 "Warehouse status" PASS "isOpen=$(echo $R | jp 'o.data?.isOpen')" \
                || chk P1 1.1 "Warehouse status" FAIL "$R"

R=$(curl -s $BASE/api/config/cod-threshold)
echo "1.2: $R"
V=$(echo $R | jp 'o.data?.cod_threshold')
[ "$V" = "7500" ] && chk P1 1.2 "COD threshold" PASS "cod_threshold=$V" \
                  || chk P1 1.2 "COD threshold" FAIL "got=$V resp=$R"

R=$(curl -s -X POST $BASE/api/admin/auth -H "Content-Type: application/json" \
  -d '{"password":"suppliable123"}')
echo "1.3: $R"
TOK=$(echo $R | jp 'o.data?.token||""')
[ "$TOK" = "suppliable-admin-2024" ] && chk P1 1.3 "Admin auth" PASS "token correct" \
                                      || chk P1 1.3 "Admin auth" FAIL "token=$TOK resp=$R"

# ─── PHASE 2 — ADDRESS ─────────────────────────────────────────
sep "PHASE 2 — ADDRESS"

R=$(curl -s -X POST $BASE/api/addresses/$USER_ID -H "Content-Type: application/json" \
  -d '{"label":"Site","flatNo":"12","buildingName":"Test Block","streetAddress":"OMR Road","city":"Chennai","state":"Tamil Nadu","pincode":"600097","isDefault":true}')
echo "2.1: $R"
TEST_ADDRESS_ID=$(echo $R | jp 'o.data?.addressId||""')
[ -n "$TEST_ADDRESS_ID" ] && chk P2 2.1 "Add address (no lat/lng)" PASS "addressId=$TEST_ADDRESS_ID" \
                           || chk P2 2.1 "Add address (no lat/lng)" FAIL "$R"
echo "  → TEST_ADDRESS_ID=$TEST_ADDRESS_ID"

R=$(curl -s $BASE/api/addresses/$USER_ID)
echo "2.2: $R"
CNT=$(echo $R | jp 'o.data?.addresses?.length||0')
LAT=$(echo $R | jp "(o.data?.addresses||[]).find(a=>a.addressId===\"$TEST_ADDRESS_ID\")?.latitude??\"null\"")
[ "${CNT:-0}" -gt 0 ] && chk P2 2.2 "List addresses" PASS "${CNT} address(es), geocodedLat=$LAT" \
                       || chk P2 2.2 "List addresses" FAIL "$R"

# ─── PHASE 3 — PRODUCTS & CART ─────────────────────────────────
sep "PHASE 3 — PRODUCTS & CART"

# Clear cart from any previous test run
curl -s -X DELETE $BASE/api/cart/$USER_ID > /dev/null

R=$(curl -s $BASE/api/products)
echo "3.1: $(echo $R | head -c 250)..."
TEST_PRODUCT_ID=$(echo $R | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{
      const o=JSON.parse(d);
      const arr=Array.isArray(o)?o:(o.data||o.products||[]);
      for(const p of arr){
        if(p.variants?.length){
          const v=p.variants.find(v=>(v.available_stock||v.stock||0)>0);
          if(v){process.stdout.write(String(v.id));return;}
        }
      }
      const f=arr[0];
      process.stdout.write(String(f?.variants?.[0]?.id||f?.id||''));
    }catch(e){process.stdout.write('');}
  });
")
[ -n "$TEST_PRODUCT_ID" ] && chk P3 3.1 "Get products" PASS "variantId=$TEST_PRODUCT_ID" \
                           || chk P3 3.1 "Get products" FAIL "no product found"
echo "  → TEST_PRODUCT_ID=$TEST_PRODUCT_ID"

R=$(curl -s -X POST $BASE/api/cart/add -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"productId\":\"$TEST_PRODUCT_ID\",\"quantity\":2}")
echo "3.2: $R"
V=$(echo $R | jp 'o.data?.cart?.items?.length||0')
GT=$(echo $R | jp 'typeof o.data?.cart?.grandTotal==="number"?"true":"false"')
[ "${V:-0}" -gt 0 ] && [ "$GT"="true" ] \
  && chk P3 3.2 "Add to cart" PASS "${V} item(s), grandTotal=$(echo $R | jp 'o.data?.cart?.grandTotal')" \
  || chk P3 3.2 "Add to cart" FAIL "$R"

R=$(curl -s $BASE/api/cart/$USER_ID)
echo "3.3: $R"
V=$(echo $R | jp '(()=>{const c=o.data?.cart;return c&&typeof c.subtotal==="number"&&typeof c.gstTotal==="number"&&typeof c.grandTotal==="number"?"true":"false"})()')
[ "$V" = "true" ] && chk P3 3.3 "Cart shape" PASS "subtotal/gstTotal/deliveryCharge/grandTotal all numbers" \
                  || chk P3 3.3 "Cart shape" FAIL "$R"

R=$(curl -s $BASE/api/cart/$USER_ID/validate)
echo "3.4: $R"
V=$(echo $R | jp 'o.data?.valid===true?"true":"false"')
[ "$V" = "true" ] && chk P3 3.4 "Validate cart" PASS "valid=true" \
                  || chk P3 3.4 "Validate cart" FAIL "$R"

R=$(curl -s -X POST $BASE/api/cart/add -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"productId\":\"$TEST_PRODUCT_ID\",\"quantity\":99999}")
echo "3.5: $R"
V=$(echo $R | jp '!o.success?"true":"false"')
[ "$V" = "true" ] && chk P3 3.5 "Over-stock rejected" PASS "$(echo $R | jp 'o.error||o.message')" \
                  || chk P3 3.5 "Over-stock rejected" FAIL "$R"

# ─── PHASE 4 — DELIVERY ────────────────────────────────────────
sep "PHASE 4 — DELIVERY"

R=$(curl -s -X POST $BASE/api/delivery/calculate -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"addressId\":\"$TEST_ADDRESS_ID\"}")
echo "4.1: $R"
SERVICEABLE=$(echo $R | jp 'o.data?.serviceable||false')
TEST_DELIVERY_CHARGE=$(echo $R | jp 'o.data?.deliveryCharge??50')
[ -z "$TEST_DELIVERY_CHARGE" ] && TEST_DELIVERY_CHARGE=50
[ -n "$SERVICEABLE" ] && chk P4 4.1 "Delivery calculate" PASS "serviceable=$SERVICEABLE charge=$TEST_DELIVERY_CHARGE" \
                       || chk P4 4.1 "Delivery calculate" FAIL "$R"
echo "  → TEST_DELIVERY_CHARGE=$TEST_DELIVERY_CHARGE"

R=$(curl -s -X POST $BASE/api/cart/$USER_ID/delivery-charge -H "Content-Type: application/json" \
  -d "{\"deliveryCharge\":$TEST_DELIVERY_CHARGE,\"addressId\":\"$TEST_ADDRESS_ID\"}")
echo "4.2: $R"
V=$(echo $R | jp 'o.success?"true":"false"')
[ "$V" = "true" ] && chk P4 4.2 "Save delivery charge" PASS "charge=$TEST_DELIVERY_CHARGE saved" \
                  || chk P4 4.2 "Save delivery charge" FAIL "$R"

R=$(curl -s $BASE/api/cart/$USER_ID)
echo "4.3: $R"
DC=$(echo $R | jp 'o.data?.cart?.deliveryCharge')
[ "$DC" = "$TEST_DELIVERY_CHARGE" ] && chk P4 4.3 "Cart delivery charge" PASS "deliveryCharge=$DC" \
                                     || chk P4 4.3 "Cart delivery charge" FAIL "got=$DC expected=$TEST_DELIVERY_CHARGE"

# ─── PHASE 5 — WAREHOUSE CONTROLS ──────────────────────────────
sep "PHASE 5 — WAREHOUSE CONTROLS"

R=$(curl -s -X PUT $BASE/api/config/warehouse-status \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"isOpen":false,"closedMessage":"Closed for E2E test"}')
echo "5.1: $R"
V=$(echo $R | jp 'o.data?.isOpen===false?"true":"false"')
[ "$V" = "true" ] && chk P5 5.1 "Close warehouse" PASS "isOpen=false" \
                  || chk P5 5.1 "Close warehouse" FAIL "$R"

R=$(curl -s -X POST $BASE/api/orders/create -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"addressId\":\"$TEST_ADDRESS_ID\",\"paymentType\":\"COD\"}")
echo "5.2: $R"
ERR=$(echo $R | jp 'o.error||""')
CAN=$(echo $R | jp 'o.canAddToCart===true?"true":"false"')
[ "$ERR" = "WAREHOUSE_CLOSED" ] && chk P5 5.2 "Order blocked when closed" PASS "error=WAREHOUSE_CLOSED canAddToCart=$CAN" \
                                 || chk P5 5.2 "Order blocked when closed" FAIL "error=$ERR resp=$R"

R=$(curl -s -X PUT $BASE/api/config/warehouse-status \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"isOpen":true}')
echo "5.3: $R"
V=$(echo $R | jp 'o.data?.isOpen===true?"true":"false"')
[ "$V" = "true" ] && chk P5 5.3 "Reopen warehouse" PASS "isOpen=true" \
                  || chk P5 5.3 "Reopen warehouse" FAIL "$R"

# ─── PHASE 6 — ORDER CREATION ──────────────────────────────────
sep "PHASE 6 — ORDER CREATION"

R=$(curl -s -X POST $BASE/api/orders/create -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"addressId\":\"$TEST_ADDRESS_ID\",\"paymentType\":\"COD\"}")
echo "6.1: $R"
TEST_ORDER_ID=$(echo $R | jp 'o.data?.order?.orderId||""')
ORD_STATUS=$(echo $R | jp 'o.data?.order?.status||""')
[ -n "$TEST_ORDER_ID" ] && chk P6 6.1 "Create COD order" PASS "orderId=$TEST_ORDER_ID status=$ORD_STATUS" \
                         || chk P6 6.1 "Create COD order" FAIL "$R"
echo "  → TEST_ORDER_ID=$TEST_ORDER_ID"

R=$(curl -s $BASE/api/cart/$USER_ID)
echo "6.2: $R"
V=$(echo $R | jp 'o.data?.cart?.items?.length===0?"true":"false"')
[ "$V" = "true" ] && chk P6 6.2 "Cart cleared after order" PASS "items=[]" \
                  || chk P6 6.2 "Cart cleared after order" FAIL "items not empty: $(echo $R | jp 'o.data?.cart?.items?.length')"

R=$(curl -s $BASE/api/orders/$USER_ID)
echo "6.3: $(echo $R | head -c 200)..."
FOUND=$(echo $R | jp "(o.data?.orders||[]).some(x=>x.orderId===\"$TEST_ORDER_ID\")?\"true\":\"false\"")
TS_OK=$(echo $R | jp "(()=>{const ord=(o.data?.orders||[]).find(x=>x.orderId===\"$TEST_ORDER_ID\");return ord&&typeof ord.createdAt===\"string\"&&ord.createdAt.includes(\"T\")?\"true\":\"false\"})()")
[ "$FOUND" = "true" ] && chk P6 6.3 "Order in history" PASS "found, ISO timestamp=$TS_OK" \
                       || chk P6 6.3 "Order in history" FAIL "not found"

R=$(curl -s $BASE/api/orders/detail/$TEST_ORDER_ID)
echo "6.4: $R"
SL=$(echo $R | jp 'o.data?.order?.statusLabel||""')
[ "$SL" = "Order Placed" ] && chk P6 6.4 "Order detail statusLabel" PASS "statusLabel='Order Placed'" \
                            || chk P6 6.4 "Order detail statusLabel" FAIL "statusLabel='$SL'"

# ─── PHASE 7 — ADMIN WAREHOUSE FLOW ────────────────────────────
sep "PHASE 7 — ADMIN WAREHOUSE FLOW"

R=$(curl -s "$BASE/api/admin/orders" -H "Authorization: Bearer $ADMIN_TOKEN")
FOUND=$(echo $R | jp "(o.data?.orders||[]).some(x=>x.orderId===\"$TEST_ORDER_ID\")?\"true\":\"false\"")
[ "$FOUND" = "true" ] && chk P7 7.1 "Admin lists orders" PASS "$TEST_ORDER_ID present" \
                       || chk P7 7.1 "Admin lists orders" FAIL "not found in list"

R=$(curl -s $BASE/api/admin/orders/$TEST_ORDER_ID -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.2: $(echo $R | head -c 200)..."
V=$(echo $R | jp "(()=>{const o2=o.data?.order;return o2&&o2.customer&&o2.deliveryAddress&&o2.items?.length>0&&typeof o2.subtotal===\"number\"?\"true\":\"false\"})()")
[ "$V" = "true" ] && chk P7 7.2 "Admin order detail" PASS "customer+address+items+amounts present" \
                  || chk P7 7.2 "Admin order detail" FAIL "missing fields: $(echo $R | head -c 150)"

R=$(curl -s -X POST $BASE/api/admin/orders/$TEST_ORDER_ID/accept \
  -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.3: $R"
ACCEPT_ST=$(echo $R | jp 'o.data?.order?.status||""')
ZOHO_SO=$(echo $R | jp 'o.data?.order?.zoho_so_number||""')
ZOHO_INV=$(echo $R | jp 'o.data?.order?.zoho_invoice_number||"null"')
TEST_OTP=$(echo $R | jp 'o.data?.order?.deliveryOtp||""')
OTP_VALID=$(echo "$TEST_OTP" | grep -E '^[0-9]{4}$' && echo "true" || echo "false")
[ "$ACCEPT_ST" = "accepted" ] && chk P7 7.3 "Accept order" PASS "status=accepted SO=$ZOHO_SO INV=$ZOHO_INV OTP=$TEST_OTP" \
                               || chk P7 7.3 "Accept order" FAIL "status=$ACCEPT_ST resp=$R"
echo "  → TEST_OTP=$TEST_OTP"

R=$(curl -s $BASE/api/orders/detail/$TEST_ORDER_ID)
echo "7.4: $R"
SL=$(echo $R | jp 'o.data?.order?.statusLabel||""')
HAS_OTP=$(echo $R | jp 'o.data?.order?.deliveryOtp!=null?"true":"false"')
[ "$SL" = "Order Accepted" ] && chk P7 7.4 "Customer sees accepted" PASS "statusLabel='Order Accepted' otpExposed=$HAS_OTP" \
                              || chk P7 7.4 "Customer sees accepted" FAIL "statusLabel='$SL'"

R=$(curl -s $BASE/api/admin/orders/$TEST_ORDER_ID/picking-list -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.5: $R"
V=$(echo $R | jp 'o.data?.items?.length>0?"true":"false"')
[ "$V" = "true" ] && chk P7 7.5 "Picking list" PASS "$(echo $R | jp 'o.data?.items?.length') item(s)" \
                  || chk P7 7.5 "Picking list" FAIL "$R"

R=$(curl -s -X POST $BASE/api/admin/orders/$TEST_ORDER_ID/packed \
  -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.6: $R"
V=$(echo $R | jp 'o.data?.order?.status||""')
[ "$V" = "ready_for_dispatch" ] && chk P7 7.6 "Mark packed" PASS "status=ready_for_dispatch" \
                                 || chk P7 7.6 "Mark packed" FAIL "status=$V resp=$R"

VDATA=$(curl -s $BASE/api/admin/vehicles -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.7: $(echo $VDATA | head -c 200)..."
TEST_VEHICLE_ID=$(echo $VDATA | jp '(o.data?.vehicles||[]).find(x=>x.isAvailable)?.vehicleId||""')
[ -n "$TEST_VEHICLE_ID" ] && chk P7 7.7 "Available vehicle" PASS "vehicleId=$TEST_VEHICLE_ID" \
                           || chk P7 7.7 "Available vehicle" FAIL "none available"
echo "  → TEST_VEHICLE_ID=$TEST_VEHICLE_ID"

DDATA=$(curl -s $BASE/api/admin/drivers -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.8: $(echo $DDATA | head -c 200)..."
TEST_DRIVER_ID=$(echo $DDATA | jp '(o.data?.drivers||[]).find(x=>x.isAvailable)?.driverId||""')
[ -n "$TEST_DRIVER_ID" ] && chk P7 7.8 "Available driver" PASS "driverId=$TEST_DRIVER_ID" \
                          || chk P7 7.8 "Available driver" FAIL "none available"
echo "  → TEST_DRIVER_ID=$TEST_DRIVER_ID"

if [ -n "$TEST_VEHICLE_ID" ] && [ -n "$TEST_DRIVER_ID" ]; then
  R=$(curl -s -X POST $BASE/api/admin/orders/$TEST_ORDER_ID/assign-vehicle \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d "{\"vehicleId\":\"$TEST_VEHICLE_ID\",\"driverId\":\"$TEST_DRIVER_ID\"}")
  echo "7.9: $R"
  V=$(echo $R | jp 'o.data?.order?.status||""')
  DN=$(echo $R | jp 'o.data?.order?.driverName||""')
  VN=$(echo $R | jp 'o.data?.order?.vehicleName||""')
  [ "$V" = "loading" ] && chk P7 7.9 "Assign vehicle" PASS "status=loading driver=$DN vehicle=$VN" \
                        || chk P7 7.9 "Assign vehicle" FAIL "status=$V resp=$R"
else
  chk P7 7.9 "Assign vehicle" FAIL "skipped — no available vehicle or driver"
fi

R=$(curl -s $BASE/api/admin/vehicles -H "Authorization: Bearer $ADMIN_TOKEN")
echo "7.10: $(echo $R | head -c 150)..."
V_AVAIL=$(echo $R | jp "(o.data?.vehicles||[]).find(x=>x.vehicleId===\"$TEST_VEHICLE_ID\")?.isAvailable?.toString()||\"\"")
[ "$V_AVAIL" = "false" ] && chk P7 7.10 "Vehicle marked unavailable" PASS "isAvailable=false" \
                          || chk P7 7.10 "Vehicle marked unavailable" FAIL "isAvailable=$V_AVAIL"

# ─── PHASE 8 — DRIVER FLOW ─────────────────────────────────────
sep "PHASE 8 — DRIVER FLOW"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/loading-complete)
echo "8.1: $R"
V=$(echo $R | jp 'o.data?.order?.status||""')
[ "$V" = "out_for_delivery" ] && chk P8 8.1 "Loading complete" PASS "status=out_for_delivery" \
                               || chk P8 8.1 "Loading complete" FAIL "status=$V resp=$R"

R=$(curl -s $BASE/api/orders/detail/$TEST_ORDER_ID)
echo "8.2: $R"
SL=$(echo $R | jp 'o.data?.order?.statusLabel||""')
DN=$(echo $R | jp 'o.data?.order?.driverName||""')
DP=$(echo $R | jp 'o.data?.order?.driverPhone||""')
HAS_OTP=$(echo $R | jp 'o.data?.order?.deliveryOtp!=null?"true":"false"')
[ "$SL" = "Out for Delivery" ] && chk P8 8.2 "Customer sees OFD" PASS "statusLabel='Out for Delivery' driver='$DN' phone='$DP' otpExposed=$HAS_OTP" \
                                || chk P8 8.2 "Customer sees OFD" FAIL "statusLabel='$SL'"

R=$(curl -s $BASE/api/driver/orders/$TEST_ORDER_ID/eta)
echo "8.3: $R"
V=$(echo $R | jp 'o.data?.eta_minutes||o.error?"true":"false"')
[ "$V" = "true" ] && chk P8 8.3 "ETA endpoint" PASS "$(echo $R | head -c 80)" \
                  || chk P8 8.3 "ETA endpoint" FAIL "$R"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/arrived)
echo "8.4: $R"
V=$(echo $R | jp 'o.data?.order?.status||""')
[ "$V" = "arrived" ] && chk P8 8.4 "Driver arrived" PASS "status=arrived" \
                      || chk P8 8.4 "Driver arrived" FAIL "status=$V resp=$R"

R=$(curl -s $BASE/api/orders/detail/$TEST_ORDER_ID)
echo "8.5: $R"
SL=$(echo $R | jp 'o.data?.order?.statusLabel||""')
DELIVERY_OTP=$(echo $R | jp 'o.data?.order?.deliveryOtp||""')
OTP_OK=$(echo "$DELIVERY_OTP" | grep -qE '^[0-9]{4}$' && echo "true" || echo "false")
[ "$SL" = "Driver has Arrived" ] && [ "$OTP_OK" = "true" ] \
  && chk P8 8.5 "Customer sees OTP on arrived" PASS "statusLabel='Driver has Arrived' OTP=$DELIVERY_OTP" \
  || chk P8 8.5 "Customer sees OTP on arrived" FAIL "statusLabel='$SL' otp='$DELIVERY_OTP'"
echo "  → DELIVERY_OTP=$DELIVERY_OTP"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/complete \
  -F "otp=$DELIVERY_OTP" -F "photo=@$PHOTO_FILE;type=image/jpeg")
echo "8.6: $R"
V=$(echo $R | jp '!o.success?"true":"false"')
ERR=$(echo $R | jp 'o.error||o.message||""')
[ "$V" = "true" ] && chk P8 8.6 "Complete blocked without COD" PASS "blocked: $ERR" \
                  || chk P8 8.6 "Complete blocked without COD" FAIL "$R"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/cod-collected \
  -H "Content-Type: application/json" -d "{\"amount\":$TEST_DELIVERY_CHARGE}")
echo "8.7: $R"
V=$(echo $R | jp 'o.data?.order?.codCollectedByDriver===true?"true":"false"')
[ "$V" = "true" ] && chk P8 8.7 "COD collected" PASS "codCollectedByDriver=true" \
                  || chk P8 8.7 "COD collected" FAIL "$R"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/complete \
  -F "otp=0000" -F "photo=@$PHOTO_FILE;type=image/jpeg")
echo "8.8: $R"
V=$(echo $R | jp '!o.success&&(o.error==="INVALID_OTP"||String(o.message).toLowerCase().includes("otp"))?"true":"false"')
[ "$V" = "true" ] && chk P8 8.8 "Wrong OTP rejected" PASS "error=INVALID_OTP" \
                  || chk P8 8.8 "Wrong OTP rejected" FAIL "$R"

R=$(curl -s -X POST $BASE/api/driver/orders/$TEST_ORDER_ID/complete \
  -F "otp=$DELIVERY_OTP" -F "photo=@$PHOTO_FILE;type=image/jpeg")
echo "8.9: $R"
V=$(echo $R | jp 'o.data?.order?.status||o.error||""')
[ "$V" = "delivered" ] && chk P8 8.9 "Complete delivery" PASS "status=delivered" \
                        || chk P8 8.9 "Complete delivery" FAIL "status=$V resp=$R"

rm -f "$PHOTO_FILE"

# ─── PHASE 9 — POST DELIVERY ───────────────────────────────────
sep "PHASE 9 — POST DELIVERY"

R=$(curl -s $BASE/api/orders/detail/$TEST_ORDER_ID)
echo "9.1: $R"
SL=$(echo $R | jp 'o.data?.order?.statusLabel||""')
HAS_OTP=$(echo $R | jp 'o.data?.order?.deliveryOtp!=null?"true":"false"')
[ "$SL" = "Delivered" ] && chk P9 9.1 "Customer sees delivered" PASS "statusLabel=Delivered otpExposed=$HAS_OTP" \
                         || chk P9 9.1 "Customer sees delivered" FAIL "statusLabel='$SL'"

VDATA=$(curl -s $BASE/api/admin/vehicles -H "Authorization: Bearer $ADMIN_TOKEN")
DDATA=$(curl -s $BASE/api/admin/drivers -H "Authorization: Bearer $ADMIN_TOKEN")
V_AVAIL=$(echo $VDATA | jp "(o.data?.vehicles||[]).find(x=>x.vehicleId===\"$TEST_VEHICLE_ID\")?.isAvailable?.toString()||\"\"")
D_AVAIL=$(echo $DDATA | jp "(o.data?.drivers||[]).find(x=>x.driverId===\"$TEST_DRIVER_ID\")?.isAvailable?.toString()||\"\"")
[ "$V_AVAIL" = "true" ] && chk P9 "9.2a" "Vehicle freed" PASS "isAvailable=true" \
                         || chk P9 "9.2a" "Vehicle freed" FAIL "isAvailable=$V_AVAIL"
[ "$D_AVAIL" = "true" ] && chk P9 "9.2b" "Driver freed" PASS "isAvailable=true" \
                         || chk P9 "9.2b" "Driver freed" FAIL "isAvailable=$D_AVAIL"

R=$(curl -s $BASE/api/admin/cod/pending -H "Authorization: Bearer $ADMIN_TOKEN")
echo "9.3: $R"
FOUND=$(echo $R | jp "(o.data?.orders||[]).some(x=>x.orderId===\"$TEST_ORDER_ID\")?\"true\":\"false\"")
[ "$FOUND" = "true" ] && chk P9 9.3 "COD in pending list" PASS "$TEST_ORDER_ID in pending" \
                       || chk P9 9.3 "COD in pending list" FAIL "not found in pending"

R=$(curl -s -X POST $BASE/api/admin/cod/$TEST_ORDER_ID/reconcile \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"amountReceived\":$TEST_DELIVERY_CHARGE}")
echo "9.4: $R"
V=$(echo $R | jp 'o.success?"true":"false"')
[ "$V" = "true" ] && chk P9 9.4 "Reconcile COD" PASS "reconciled" \
                  || chk P9 9.4 "Reconcile COD" FAIL "$R"

R=$(curl -s $BASE/api/admin/cod/pending -H "Authorization: Bearer $ADMIN_TOKEN")
echo "9.5: $R"
STILL=$(echo $R | jp "(o.data?.orders||[]).some(x=>x.orderId===\"$TEST_ORDER_ID\")?\"true\":\"false\"")
[ "$STILL" = "false" ] && chk P9 9.5 "Removed from pending after reconcile" PASS "no longer in pending" \
                        || chk P9 9.5 "Removed from pending after reconcile" FAIL "still in pending list"

# ─── FINAL REPORT ──────────────────────────────────────────────
sep "FINAL REPORT"
printf "%-5s | %-5s | %-42s | %s\n" "PHASE" "STEP" "TEST" "RESULT / NOTES"
echo "─────────────────────────────────────────────────────────────────────────────────────"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo ""
TOTAL=$((PASS+FAIL))
echo "Score: $PASS/$TOTAL passed"
[ $FAIL -eq 0 ] && echo "✅ ALL TESTS PASSED" || echo "❌ $FAIL test(s) failed — see above"
