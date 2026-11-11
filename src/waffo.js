/* Waffo 支付：创建收银台会话 + 用订单号回查是否已付。
   签名实现复用 looprel 的纯 JS RSA——Waffo 的生产密钥会被 BoringSSL 严格校验拒绝 importKey，
   但密钥本身有效，服务端验签通过。 */
'use strict';

const WAFFO_API = 'https://api.waffo.ai';
export const REF_RE = /^vb_[a-z0-9]{8,64}$/;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function derRead(bytes, pos) {
  const tag = bytes[pos];
  let len = bytes[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[pos + 2 + i];
    hdr = 2 + n;
  }
  return { tag, len, valueStart: pos + hdr, valueEnd: pos + hdr + len };
}
function derToBigInt(bytes, start, end) {
  let hex = '';
  for (let i = start; i < end; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return BigInt('0x' + (hex || '0'));
}
function parsePkcs8Rsa(der) {
  const outer = derRead(der, 0);
  let pos = outer.valueStart;
  let it = derRead(der, pos); pos = it.valueEnd; // version
  it = derRead(der, pos); pos = it.valueEnd;     // algorithm
  it = derRead(der, pos);                        // privateKey OCTET STRING
  const inner = der.slice(it.valueStart, it.valueEnd);
  const seq = derRead(inner, 0);
  let pos2 = seq.valueStart;
  const readInt = () => {
    const r = derRead(inner, pos2);
    pos2 = r.valueEnd;
    return derToBigInt(inner, r.valueStart, r.valueEnd);
  };
  readInt(); // version
  const n = readInt();
  readInt(); // e
  const d = readInt();
  const p = readInt();
  const q = readInt();
  const dp = readInt();
  const dq = readInt();
  const qinv = readInt();
  return { n, d, p, q, dp, dq, qinv };
}
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}
function bigIntToBytes(value, length) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = new Uint8Array(length);
  const src = hex.match(/../g) || [];
  const offset = length - src.length;
  for (let i = 0; i < src.length; i++) bytes[offset + i] = parseInt(src[i], 16);
  return bytes;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function rsaSignPkcs1v15(derB64, message) {
  const { n, p, q, dp, dq, qinv } = parsePkcs8Rsa(b64ToBytes(derB64));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message)));
  let hashHex = '';
  for (const b of hash) hashHex += b.toString(16).padStart(2, '0');
  const digestInfo = hexToBytes('3031300d060960864801650304020105000420' + hashHex);
  const k = Math.ceil(n.toString(16).length / 2);
  const em = new Uint8Array(k);
  em[1] = 0x01;
  const psLen = k - digestInfo.length - 3;
  em.fill(0xff, 2, 2 + psLen);
  em[2 + psLen] = 0x00;
  em.set(digestInfo, 3 + psLen);
  const m = derToBigInt(em, 0, em.length);
  // Waffo 签发的密钥 d 与 CRT 参数不一致，必须按 CRT 计算
  const m1 = modPow(m, dp, p);
  const m2 = modPow(m, dq, q);
  let h = (((m1 - m2) % p) + p) % p;
  h = (h * qinv) % p;
  const s = m2 + h * q;
  return bytesToB64(bigIntToBytes(s, k));
}

async function waffoPost(env, path, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000).toString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const bodyHash = bytesToB64(new Uint8Array(digest));
  const canonical = `POST\n${path}\n${ts}\n${bodyHash}`;
  const signature = await rsaSignPkcs1v15(env.WAFFO_PRIVATE_KEY, canonical);
  const res = await fetch(WAFFO_API + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-merchant-id': env.WAFFO_MERCHANT_ID,
      'x-timestamp': ts,
      'x-signature': signature,
    },
    body,
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (e) { payload = { raw: text }; }
  return { ok: res.ok, status: res.status, payload };
}

export async function createCheckout(env, { ref, origin }) {
  if (!env.WAFFO_PRIVATE_KEY || !env.WAFFO_PRODUCT_ID) return { ok: false, error: 'not_configured' };
  const { ok, payload } = await waffoPost(env, '/v1/actions/checkout/create-session', {
    // 官方 API 示例要求显式带上 storeId 与 productType：一个商户下有多个店铺，
    // 不传 storeId 时收银台可能落到错误的店铺支付通道上。
    storeId: env.WAFFO_STORE_ID,
    productId: env.WAFFO_PRODUCT_ID,
    productType: 'onetime',
    currency: 'USD',
    successUrl: `${origin}/?paid=1&ref=${encodeURIComponent(ref)}`,
    orderMerchantExternalId: ref,
    metadata: { ref, product: 'credit_pack', site: 'verbatimly' },
  });
  if (!ok || !payload || !payload.data || !payload.data.checkoutUrl) {
    console.error('waffo create-session failed', JSON.stringify(payload).slice(0, 400));
    return { ok: false, error: 'checkout_failed' };
  }
  return { ok: true, url: payload.data.checkoutUrl, sessionId: payload.data.sessionId };
}

export async function verifyOrder(env, ref) {
  if (!env.WAFFO_PRIVATE_KEY || !env.WAFFO_STORE_ID) return { ok: false, error: 'not_configured' };
  const query = `query($storeId: String!, $ref: String!) {
    onetimeOrders(storeId: $storeId, filter: { orderMerchantExternalId: { eq: $ref } }, limit: 5) {
      id status createdAt
    }
  }`;
  const { ok, payload } = await waffoPost(env, '/v1/graphql', { query, variables: { storeId: env.WAFFO_STORE_ID, ref } });
  if (!ok || !payload || !payload.data) {
    console.error('waffo verify failed', JSON.stringify(payload).slice(0, 400));
    return { ok: false, error: 'verify_failed' };
  }
  const orders = payload.data.onetimeOrders || [];
  const paid = orders.find((o) => o.status === 'completed');
  return { ok: true, paid: Boolean(paid), orderId: paid ? paid.id : null };
}
