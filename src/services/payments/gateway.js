'use strict';

/**
 * PaymentGateway interface contract.
 *
 * Every adapter (Cashfree, Razorpay, etc.) must implement these methods with
 * the exact normalized shapes documented below. Controllers and webhook
 * handlers depend on this contract only — they must never import an adapter
 * module directly.
 *
 * @typedef {Object} CustomerInput
 * @property {string} customerId
 * @property {string} customerPhone   E.164, e.g. "+919884857261"
 * @property {string} [customerName]
 * @property {string} [customerEmail]
 *
 * @typedef {Object} CreateCheckoutInput
 * @property {string} orderId            Our internal order id (also passed as provider order_id)
 * @property {number} amountInPaise      Integer paise — avoid float drift
 * @property {string} currency           ISO 4217, e.g. "INR"
 * @property {CustomerInput} customer
 * @property {string} returnUrl          Absolute HTTPS URL; provider redirects here on completion
 * @property {string} notifyUrl          Absolute HTTPS URL; provider posts webhooks here
 *
 * @typedef {Object} CreateCheckoutResult
 * @property {string} providerOrderId
 * @property {string} paymentUrl         Hosted checkout URL the WebView loads
 * @property {Object} [providerRaw]      Adapter-specific data we want to persist for audit
 *
 * @typedef {Object} FetchStatusInput
 * @property {string} providerOrderId
 *
 * @typedef {Object} FetchStatusResult
 * @property {'PAID'|'PENDING'|'FAILED'} status
 * @property {string} rawProviderStatus
 * @property {number} [amountInPaise]
 *
 * @typedef {Object} VerifyWebhookInput
 * @property {Buffer|string} rawBody     MUST be the raw body Cashfree posted (signature is over this)
 * @property {Object} headers
 *
 * @typedef {Object} VerifyWebhookResult
 * @property {boolean} isValid
 * @property {'PAYMENT_SUCCESS'|'PAYMENT_FAILED'|'OTHER'} event
 * @property {string} [providerOrderId]
 * @property {number} [amountInPaise]
 * @property {Object} [rawEvent]
 *
 * @typedef {Object} PaymentGateway
 * @property {string} name
 * @property {(input: CreateCheckoutInput) => Promise<CreateCheckoutResult>} createCheckout
 * @property {(input: FetchStatusInput) => Promise<FetchStatusResult>} fetchStatus
 * @property {(input: VerifyWebhookInput) => VerifyWebhookResult} verifyWebhook
 */

module.exports = {};
