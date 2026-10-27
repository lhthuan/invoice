// ─── stockSync.js ────────────────────────────────────────────────────────────
// Tầng dữ liệu tồn kho: tải từ Supabase (PostgREST keyset), cache IndexedDB
// dạng cột (1 record), khoá giữa các tab (Web Locks), báo tab khác
// (BroadcastChannel), upload qua RPC có mã upload.
// Không phụ thuộc React. Xem .ai-tasks/sync-overhaul/CONTRACT.md mục 2.

export const STOCK_COLS = ["ma_hang", "ten_hang", "chi_nhanh", "tinh_thanh", "ma_kho", "dvt", "cuoi_ky"];

// Tên field trong app tương ứng với STOCK_COLS (cùng thứ tự)
const ROW_FIELDS = ["maHang", "tenHang", "chiNhanh", "tinhThanh", "maKho", "dvt", "cuoiKy"];

const TABLE = "stock_by_branch";
const META_TABLE = "stock_meta";
const PAGE = 1000;
const CHUNK = 2000;
const CHUNK_RETRIES = 3;          // retry tối đa 3 lần/chunk (ngoài lần đầu)
const PAGE_ATTEMPTS = 4;          // số lần thử mỗi trang khi tải
const LOCK_NAME = "inv-stock-sync";
const BC_NAME = "inv-stock";
const DB_NAME = "InvCacheDB";
const DB_VER = 4;
const STORE = "snapshot";
const SNAP_KEY = "current";
const DB_OPEN_TIMEOUT = 15000;
// 4 khoảng theo hex đầu của uuid: [0,4) [4,8) [8,c) [c,…]
const RANGES = [
  ["00000000-0000-0000-0000-000000000000", "40000000-0000-0000-0000-000000000000"],
  ["40000000-0000-0000-0000-000000000000", "80000000-0000-0000-0000-000000000000"],
  ["80000000-0000-0000-0000-000000000000", "c0000000-0000-0000-0000-000000000000"],
  ["c0000000-0000-0000-0000-000000000000", null],
];

// ─── Trạng thái module ───────────────────────────────────────────────────────
let _getSb = null;
let _onStatus = null;
let _dbP = null;
let _bc = null;
const _subs = new Set();
let _localChain = Promise.resolve(); // mutex trong tab khi không có navigator.locks

function emit(status) {
  try { _onStatus && _onStatus(status); } catch (e) { console.warn("[stockSync] onStatus lỗi:", e); }
}

function sb() {
  const c = _getSb ? _getSb() : null;
  if (!c) throw makeError("Chưa kết nối Supabase — kiểm tra cài đặt trong Lập báo giá.", { code: "no_client" });
  return c;
}

// ─── Lỗi ─────────────────────────────────────────────────────────────────────
function makeError(message, extra = {}) {
  const e = new Error(message);
  Object.assign(e, extra);
  return e;
}

const NET_RE = /failed to fetch|networkerror|network ?error|network request failed|load failed|fetch failed|err_network|err_internet|err_connection|timed out|econnreset|econnrefused|enotfound|eai_again|socket hang up|offline/i;

function isNetworkError(err) {
  if (!err) return false;
  if (err.offline) return true;
  try { if (typeof navigator !== "undefined" && navigator.onLine === false) return true; } catch {}
  const msg = String(err.message || err) + " " + String(err.details || "");
  if (NET_RE.test(msg)) return true;
  return err.status === 0 && !err.code;
}

const RPC_MESSAGES = {
  bad_code: "Mã upload không đúng.",
  upload_in_progress: "Đang có người khác upload dữ liệu tồn kho (trong 30 phút gần đây). Vui lòng thử lại sau ít phút.",
  upload_mismatch: "Lượt upload này đã bị huỷ hoặc bị thay bởi lượt upload khác. Vui lòng upload lại.",
  row_count_mismatch: "Số dòng server nhận được không khớp với file (có thể mất dữ liệu khi gửi). Đã huỷ lượt upload, vui lòng thử lại.",
  empty_upload: "File không có dòng dữ liệu nào để upload.",
};

// Chuyển lỗi Supabase/PostgREST/mạng sang Error tiếng Việt
function mapError(err, context) {
  if (!err) return makeError(context || "Lỗi không xác định.");
  if (err instanceof Error && err._mapped) return err;
  const raw = String(err.message || err);
  const prefix = context ? context + ": " : "";
  for (const code of Object.keys(RPC_MESSAGES)) {
    if (raw.includes(code)) return tag(makeError(RPC_MESSAGES[code], { code, cause: err }));
  }
  // Lỗi Postgres có mã SQLSTATE phải xét trước lỗi mạng: "lock timeout" không phải mất mạng
  if (err.code === "55P03" || /lock timeout/i.test(raw)) {
    return tag(makeError(prefix + "Máy chủ đang bận (có máy khác đang đọc dữ liệu). Vui lòng thử lại sau ít phút.", { code: "lock_timeout", cause: err }));
  }
  if (err.code === "57014" || /statement timeout|canceling statement/i.test(raw)) {
    return tag(makeError(prefix + "Máy chủ xử lý quá lâu nên bị huỷ. Vui lòng thử lại.", { code: "timeout", cause: err }));
  }
  if (isNetworkError(err)) {
    return tag(makeError(prefix + "Không kết nối được máy chủ (mất mạng hoặc mạng chập chờn).", { code: "network", offline: true, cause: err }));
  }
  if (err.code === "PGRST202" || err.code === "42883" || err.code === "42P01" || /could not find the function|does not exist/i.test(raw)) {
    return tag(makeError(prefix + "Máy chủ chưa được cài đặt bản đồng bộ mới (cần chạy supabase/sync_overhaul_phase1.sql).", { code: "not_installed", cause: err }));
  }
  if (err.code === "42501" || /permission denied|row-level security/i.test(raw)) {
    return tag(makeError(prefix + "Không có quyền thực hiện thao tác này trên máy chủ.", { code: "forbidden", cause: err }));
  }
  return tag(makeError(prefix + raw, { code: err.code || "unknown", cause: err }));
}
function tag(e) { e._mapped = true; return e; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isPermanent(err) {
  const m = String(err?.message || "");
  if (Object.keys(RPC_MESSAGES).some(c => m.includes(c))) return true;
  if (err?._mapped && (RPC_MESSAGES[err.code] || err.code === "not_installed" || err.code === "forbidden" || err.code === "no_client")) return true;
  return ["PGRST202", "42883", "42P01", "42703", "42501", "PGRST204"].includes(err?.code);
}

// ─── Meta ────────────────────────────────────────────────────────────────────
// Meta chuẩn hoá (camelCase) dùng chung cho mọi hàm export
function normMeta(r) {
  if (!r) return null;
  return {
    version: r.version ?? null,
    status: r.status || "ready",
    rowCount: Number(r.row_count ?? r.rowCount ?? 0) || 0,
    qtySum: (r.qty_sum ?? r.qtySum) == null ? null : Number(r.qty_sum ?? r.qtySum),
    publishedAt: r.published_at ?? r.publishedAt ?? null,
    uploadId: r.upload_id ?? r.uploadId ?? null,
    uploadStartedAt: r.upload_started_at ?? r.uploadStartedAt ?? null,
    uploader: r.uploader ?? null,
    fileName: r.file_name ?? r.fileName ?? null,
  };
}

function statusInfo(meta) {
  return meta ? { version: meta.version, publishedAt: meta.publishedAt, fileName: meta.fileName } : {};
}

// ─── Cột ↔ dòng ──────────────────────────────────────────────────────────────
function emptyCols(n = 0) {
  return {
    maHang: new Array(n), tenHang: new Array(n), chiNhanh: new Array(n),
    tinhThanh: new Array(n), maKho: new Array(n), dvt: new Array(n), cuoiKy: new Float64Array(n),
  };
}

function colsToRows(cols, n) {
  const { maHang, tenHang, chiNhanh, tinhThanh, maKho, dvt, cuoiKy } = cols;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      maHang: maHang[i], tenHang: tenHang[i], chiNhanh: chiNhanh[i],
      tinhThanh: tinhThanh[i], maKho: maKho[i], dvt: dvt[i], cuoiKy: cuoiKy[i],
    };
  }
  return out;
}

function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-eE]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
const str = v => (v == null ? "" : String(v));

// Row app → cột (chuẩn hoá luôn). Trả { cols, qtySum }
function rowsToCols(rows) {
  const n = rows.length;
  const cols = emptyCols(n);
  const { maHang, tenHang, chiNhanh, tinhThanh, maKho, dvt, cuoiKy } = cols;
  let qtySum = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    maHang[i] = str(r.maHang).trim().toUpperCase();
    tenHang[i] = str(r.tenHang);
    chiNhanh[i] = str(r.chiNhanh);
    tinhThanh[i] = str(r.tinhThanh);
    maKho[i] = str(r.maKho);
    dvt[i] = str(r.dvt);
    const q = toNum(r.cuoiKy);
    cuoiKy[i] = q;
    qtySum += q;
  }
  return { cols, qtySum };
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────
function idbAvailable() {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; } catch { return false; }
}

function cacheOpen() {
  if (_dbP) return _dbP;
  if (!idbAvailable()) return Promise.reject(makeError("Trình duyệt không hỗ trợ lưu offline (IndexedDB)."));
  _dbP = new Promise((res, rej) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rej(makeError("Không mở được bộ nhớ offline. Hãy đóng các tab Tra cứu tồn kho cũ rồi tải lại trang.", { code: "idb_blocked" }));
    }, DB_OPEN_TIMEOUT);
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { clearTimeout(timer); done = true; rej(e); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (db.objectStoreNames.contains("stock")) db.deleteObjectStore("stock");
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    r.onblocked = () => {
      emit({ state: "error", error: "Đang có tab Tra cứu tồn kho bản cũ mở. Hãy đóng các tab đó rồi tải lại trang." });
    };
    r.onsuccess = () => {
      const db = r.result;
      if (done) { try { db.close(); } catch {} return; }
      done = true;
      clearTimeout(timer);
      db.onversionchange = () => { try { db.close(); } catch {} _dbP = null; };
      db.onclose = () => { _dbP = null; };
      res(db);
    };
    r.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rej(r.error || makeError("Không mở được bộ nhớ offline."));
    };
  });
  _dbP.catch(() => { _dbP = null; });
  return _dbP;
}

async function snapGet() {
  const db = await cacheOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const q = tx.objectStore(STORE).get(SNAP_KEY);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
    tx.onabort = () => rej(tx.error || makeError("Đọc bộ nhớ offline bị huỷ."));
  });
}

async function snapPut(snap) {
  const db = await cacheOpen();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(snap, SNAP_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || makeError("Ghi bộ nhớ offline lỗi."));
    tx.onabort = () => {
      const e = tx.error;
      if (e && e.name === "QuotaExceededError") rej(makeError("Máy không đủ dung lượng để lưu bản offline.", { code: "quota", cause: e }));
      else rej(e || makeError("Ghi bộ nhớ offline bị huỷ."));
    };
  });
  try { navigator?.storage?.persist?.(); } catch {}
}

// Snapshot hợp lệ = đủ field và độ dài mọi cột đúng rowCount
function validSnap(s) {
  if (!s || !s.version || !s.cols) return false;
  const n = s.rowCount;
  if (!Number.isInteger(n) || n < 0) return false;
  for (const f of ROW_FIELDS) {
    if (!s.cols[f] || s.cols[f].length !== n) return false;
  }
  return true;
}

function snapMeta(s) {
  return {
    version: s.version, status: "ready", rowCount: s.rowCount, qtySum: s.qtySum ?? null,
    publishedAt: s.publishedAt ?? null, uploadId: null, uploadStartedAt: null, uploader: s.uploader ?? null,
    fileName: s.fileName ?? null,
  };
}

function buildSnap(meta, cols, n) {
  return {
    version: meta.version, rowCount: n, qtySum: meta.qtySum, publishedAt: meta.publishedAt,
    fileName: meta.fileName, uploader: meta.uploader ?? null, savedAt: new Date().toISOString(), cols,
  };
}

async function readValidSnap() {
  try {
    const s = await snapGet();
    return validSnap(s) ? s : null;
  } catch (e) {
    console.warn("[stockSync] không đọc được cache:", e);
    return null;
  }
}

// ─── Khoá & broadcast ────────────────────────────────────────────────────────
function withLock(fn) {
  try {
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, () => fn());
    }
  } catch {}
  // Fallback: không có Web Locks → chạy thẳng, chỉ tuần tự hoá trong tab này
  const p = _localChain.then(() => fn());
  _localChain = p.catch(() => {});
  return p;
}

function broadcast(version) {
  try { _bc && _bc.postMessage({ type: "updated", version }); } catch {}
}

// ─── API ─────────────────────────────────────────────────────────────────────
export function initStockSync({ getSb, onStatus } = {}) {
  _getSb = getSb || null;
  _onStatus = onStatus || null;
  try { localStorage.removeItem("inv_cache_ts"); } catch {}
  try { localStorage.removeItem("inv_sb_updated_at"); } catch {}
  if (!_bc) {
    try {
      if (typeof BroadcastChannel !== "undefined") {
        _bc = new BroadcastChannel(BC_NAME);
        _bc.onmessage = ev => {
          const d = ev && ev.data;
          if (!d || d.type !== "updated") return;
          for (const fn of _subs) {
            try { fn({ version: d.version }); } catch (e) { console.warn("[stockSync] subscriber lỗi:", e); }
          }
        };
      }
    } catch { _bc = null; }
  }
  emit({ state: "idle" });
}

export function subscribe(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export async function loadCached() {
  const s = await readValidSnap();
  if (!s) return null;
  return { rows: colsToRows(s.cols, s.rowCount), meta: snapMeta(s) };
}

export async function fetchRemoteMeta() {
  let res;
  try {
    res = await sb().from(META_TABLE).select("*").eq("id", 1).maybeSingle();
  } catch (e) {
    throw mapError(e, "Không đọc được thông tin dữ liệu tồn kho");
  }
  if (res.error) throw mapError(res.error, "Không đọc được thông tin dữ liệu tồn kho");
  if (!res.data) throw tag(makeError("Máy chủ chưa có bảng stock_meta (cần chạy supabase/sync_overhaul_phase1.sql).", { code: "not_installed" }));
  return normMeta(res.data);
}

// Tải 1 trang, có retry
async function fetchPage(lo, hi, last) {
  let lastErr = null;
  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1));
    try {
      let q = sb().from(TABLE).select("id," + STOCK_COLS.join(","));
      q = last == null ? q.gte("id", lo) : q.gt("id", last);
      if (hi) q = q.lt("id", hi);
      const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
      if (!error && Array.isArray(data)) return data;
      lastErr = error || makeError("Phản hồi rỗng từ máy chủ");
    } catch (e) {
      lastErr = e;
    }
    if (isPermanent(lastErr)) break;
  }
  throw mapError(lastErr, "Lỗi tải dữ liệu tồn kho");
}

// Tải đủ bảng theo 4 khoảng uuid song song → { cols, n }
async function downloadAll(total) {
  let loaded = 0;
  const parts = await Promise.all(RANGES.map(async ([lo, hi]) => {
    const c = { maHang: [], tenHang: [], chiNhanh: [], tinhThanh: [], maKho: [], dvt: [], cuoiKy: [] };
    let last = null;
    for (;;) {
      const page = await fetchPage(lo, hi, last);
      const len = page.length;
      for (let i = 0; i < len; i++) {
        const r = page[i];
        c.maHang.push(str(r.ma_hang).trim().toUpperCase());
        c.tenHang.push(str(r.ten_hang));
        c.chiNhanh.push(str(r.chi_nhanh));
        c.tinhThanh.push(str(r.tinh_thanh));
        c.maKho.push(str(r.ma_kho));
        c.dvt.push(str(r.dvt));
        c.cuoiKy.push(toNum(r.cuoi_ky));
      }
      loaded += len;
      emit({ state: "downloading", loaded, total });
      if (len < PAGE) break;
      last = page[len - 1].id;
    }
    return c;
  }));
  let n = 0;
  for (const p of parts) n += p.maHang.length;
  const cols = emptyCols(n);
  let o = 0;
  for (const p of parts) {
    const len = p.maHang.length;
    for (let i = 0; i < len; i++, o++) {
      cols.maHang[o] = p.maHang[i];
      cols.tenHang[o] = p.tenHang[i];
      cols.chiNhanh[o] = p.chiNhanh[i];
      cols.tinhThanh[o] = p.tinhThanh[i];
      cols.maKho[o] = p.maKho[i];
      cols.dvt[o] = p.dvt[i];
      cols.cuoiKy[o] = p.cuoiKy[i];
    }
  }
  return { cols, n };
}

// Tải + kiểm tra row_count & version; thử lại 1 lần
async function downloadVerified(meta0) {
  let meta = meta0;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) meta = await fetchRemoteMeta();
    emit({ state: "downloading", loaded: 0, total: meta.rowCount, ...statusInfo(meta) });
    const { cols, n } = await downloadAll(meta.rowCount);
    const after = await fetchRemoteMeta();
    if (after.version !== meta.version) {
      lastErr = tag(makeError("Dữ liệu trên máy chủ vừa được cập nhật trong lúc tải. Vui lòng thử đồng bộ lại.", { code: "version_changed" }));
      continue;
    }
    if (n !== meta.rowCount) {
      lastErr = tag(makeError(`Tải thiếu dữ liệu: nhận ${n.toLocaleString("vi-VN")} / ${meta.rowCount.toLocaleString("vi-VN")} dòng. Vui lòng thử đồng bộ lại.`, { code: "row_count_mismatch" }));
      continue;
    }
    return { cols, n, meta: after };
  }
  throw lastErr;
}

export async function syncIfStale({ force = false } = {}) {
  emit({ state: "checking" });
  try {
    return await withLock(async () => {
      // Đọc cache SAU khi có khoá: tab khác có thể vừa đồng bộ xong
      const cached = await readValidSnap();
      let remote;
      try {
        remote = await fetchRemoteMeta();
      } catch (e) {
        if (isNetworkError(e)) e.offline = true;
        throw e;
      }
      const finalState = remote.status === "uploading" ? "uploading-elsewhere" : "ready";

      if (!remote.version) {
        // Máy chủ chưa có bản dữ liệu nào
        emit({ state: finalState, loaded: 0, total: 0, ...statusInfo(remote) });
        return { rows: [], meta: remote, changed: false };
      }
      if (!force && cached && cached.version === remote.version) {
        const meta = snapMeta(cached);
        emit({ state: finalState, loaded: cached.rowCount, total: cached.rowCount, ...statusInfo(meta) });
        return { rows: colsToRows(cached.cols, cached.rowCount), meta, changed: false };
      }

      const { cols, n, meta: got } = await downloadVerified(remote);
      // status của bản vừa tải (bảng chính) luôn là ready
      const meta = { ...got, status: "ready", uploadId: null, uploadStartedAt: null };
      emit({ state: "saving", loaded: n, total: n, ...statusInfo(meta) });
      let saveErr = null;
      try {
        await snapPut(buildSnap(meta, cols, n));
        broadcast(meta.version);
      } catch (e) {
        saveErr = e;
        console.warn("[stockSync] không lưu được cache:", e);
      }
      const changed = !cached || cached.version !== meta.version;
      emit({
        state: got.status === "uploading" ? "uploading-elsewhere" : "ready",
        loaded: n, total: n, ...statusInfo(meta),
        ...(saveErr ? { error: "Không lưu được bản offline: " + (saveErr.message || saveErr) } : {}),
      });
      return { rows: colsToRows(cols, n), meta, changed };
    });
  } catch (e0) {
    const e = mapError(e0, "Đồng bộ tồn kho thất bại");
    if (isNetworkError(e0) || e.offline) {
      e.offline = true;
      emit({ state: "offline", error: e.message });
    } else {
      emit({ state: "error", error: e.message });
    }
    throw e;
  }
}

async function rpc(name, args) {
  let res;
  try { res = await sb().rpc(name, args); }
  catch (e) { throw mapError(e); }
  if (res.error) throw mapError(res.error);
  return res.data;
}

export async function uploadStock({ code, rows, uploader = "", fileName = "", onProgress } = {}) {
  if (!code || !String(code).trim()) throw tag(makeError("Vui lòng nhập mã upload.", { code: "bad_code" }));
  if (!Array.isArray(rows) || rows.length === 0) throw tag(makeError(RPC_MESSAGES.empty_upload, { code: "empty_upload" }));
  const p_code = String(code).trim();
  const { cols, qtySum } = rowsToCols(rows);
  const n = rows.length;
  const report = done => { try { onProgress && onProgress(done, n); } catch {} };

  // Phiên bản trước khi upload — dùng để nhận biết commit thật sự đã thành công khi mất phản hồi
  const versionBefore = (await fetchRemoteMeta().catch(() => null))?.version ?? null;
  const uploadId = await rpc("stock_begin_upload", {
    p_code, p_expected_rows: n, p_uploader: uploader || null, p_file_name: fileName || null,
  });
  if (!uploadId) throw tag(makeError("Máy chủ không trả về mã lượt upload.", { code: "unknown" }));

  let metaRow;
  try {
    report(0);
    for (let seq = 0, i = 0; i < n; seq++, i += CHUNK) {
      const end = Math.min(i + CHUNK, n);
      const chunk = new Array(end - i);
      for (let j = i; j < end; j++) {
        chunk[j - i] = {
          ma_hang: cols.maHang[j], ten_hang: cols.tenHang[j], chi_nhanh: cols.chiNhanh[j],
          tinh_thanh: cols.tinhThanh[j], ma_kho: cols.maKho[j], dvt: cols.dvt[j], cuoi_ky: cols.cuoiKy[j],
        };
      }
      let lastErr = null, ok = false;
      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        if (attempt) await sleep(800 * attempt);
        try {
          const cnt = await rpc("stock_upload_chunk", { p_code, p_upload_id: uploadId, p_seq: seq, p_rows: chunk });
          if (cnt != null && Number(cnt) !== chunk.length) {
            lastErr = tag(makeError(`Máy chủ chỉ nhận ${cnt}/${chunk.length} dòng ở đoạn ${seq + 1}.`, { code: "chunk_mismatch" }));
            continue;
          }
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          if (isPermanent(e)) break;
        }
      }
      if (!ok) {
        const e = mapError(lastErr);
        if (!RPC_MESSAGES[e.code]) e.message = `Lỗi gửi dòng ${i + 1}–${end}: ${e.message}`;
        throw e;
      }
      report(end);
    }

    // Commit: lock_timeout thì thử lại (transaction đã rollback, an toàn)
    for (let attempt = 0; ; attempt++) {
      try {
        metaRow = await rpc("stock_commit_upload", { p_code, p_upload_id: uploadId, p_expected_rows: n, p_qty_sum: qtySum });
        break;
      } catch (e) {
        if (e.code === "lock_timeout" && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
        if (e.offline) {
          // Có thể commit đã thành công nhưng mất phản hồi → kiểm tra meta
          try {
            const m = await fetchRemoteMeta();
            const committed = m.status === "ready" && !m.uploadId && m.rowCount === n && m.version
              && versionBefore && m.version !== versionBefore
              && (m.qtySum == null || Math.abs(Number(m.qtySum) - qtySum) < 1e-6 * Math.max(1, Math.abs(qtySum)));
            if (committed) { metaRow = m; break; }
          } catch {}
        }
        throw e;
      }
    }
  } catch (err) {
    try { await sb().rpc("stock_abort_upload", { p_code, p_upload_id: uploadId }); } catch {}
    throw mapError(err, "Upload thất bại");
  }

  const meta = normMeta(metaRow);
  if (!meta.version) meta.version = (await fetchRemoteMeta().catch(() => null))?.version || null;
  if (meta.fileName == null) meta.fileName = fileName || null;
  if (meta.qtySum == null) meta.qtySum = qtySum;
  meta.rowCount = meta.rowCount || n;

  // Ghi cache trực tiếp từ rows (upload đã thành công; lỗi cache không làm hỏng upload)
  let saveErr = null;
  if (meta.version) {
    try {
      await withLock(async () => {
        await snapPut(buildSnap(meta, cols, n));
        broadcast(meta.version);
      });
    } catch (e) {
      saveErr = e;
      console.warn("[stockSync] upload xong nhưng không lưu được cache:", e);
    }
  }
  emit({
    state: "ready", loaded: n, total: n, ...statusInfo(meta),
    ...(saveErr ? { error: "Không lưu được bản offline: " + (saveErr.message || saveErr) } : {}),
  });
  return meta;
}
