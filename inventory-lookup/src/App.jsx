import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import { initStockSync, loadCached, syncIfStale, uploadStock, subscribe, contentHashOfRows } from "./stockSync.js";
import { analyzeWorkbook, normHeader } from "./excelParse.js";

// ─── BUILD INFO ──────────────────────────────────────────────────────────────
const BUILD_DATE = new Date(__BUILD_TIME__).toLocaleString("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit", timeZone:"Asia/Ho_Chi_Minh" });
const VERSION = "2.1.0";

// ─── COLORS (Light ERP Theme) ─────────────────────────────────────────────────
const C = {
  bg:           "#f0f2f5",
  surface:      "#ffffff",
  surface2:     "#f5f7fa",
  surface3:     "#eaecf0",
  border:       "#ced4da",
  borderLight:  "#e9ecef",
  headerBg:     "#1e3a5f",
  headerText:   "#ffffff",
  sidebarBg:    "#1e3a5f",
  sidebarText:  "#b8cde0",
  sidebarActive:"#ffffff",
  sidebarActiveBg:"#2d5490",
  accent:       "#0d7a4e",
  accentBg:     "#e6f4ee",
  accentBorder: "#7dc5a0",
  blue:         "#1a6fba",
  blueBg:       "#e8f1fb",
  blueBorder:   "#8cbde8",
  amber:        "#92400e",
  amberBg:      "#fef3c7",
  amberBorder:  "#fcd34d",
  red:          "#b91c1c",
  redBg:        "#fee2e2",
  redBorder:    "#fca5a5",
  text:         "#1a2332",
  dim:          "#4a5568",
  muted:        "#9aa5b4",
  mutedLight:   "#6b7a8d",
};

// ─── SUPABASE CONFIG ─────────────────────────────────────────────────────────
const SB_URL = "https://kyimvqljohydxpoosxln.supabase.co";

function getSbCfg() {
  try { return JSON.parse(localStorage.getItem("tsp_v2_config") || "{}"); } catch { return {}; }
}
let _sbClient = null;
function getSb() {
  if (_sbClient) return _sbClient;
  const key = getSbCfg().supabaseKey ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt5aW12cWxqb2h5ZHhwb29zeGxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMTMyMTcsImV4cCI6MjA5Nzg4OTIxN30.9y9DYpr6JltKFy4LRQKWqKqIpeq5IiosvgJT8JaBoWg";
  try { _sbClient = createClient(SB_URL, key); return _sbClient; }
  catch { return null; }
}

// ─── BRANCH MAP (chi_nhanh → tinh_thanh) ─────────────────────────────────────
const LS_BRANCH_MAP = 'tsp_branch_map';
let _branchMap = {};
try { _branchMap = JSON.parse(localStorage.getItem(LS_BRANCH_MAP) || '{}'); } catch {}

const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

async function loadBranchMap() {
  const sb = getSb();
  if (!sb) return;
  const { data, error } = await sb.from('branches').select('chi_nhanh, tinh_thanh');
  if (error) throw new Error(error.message);
  if (data?.length) {
    const map = {};
    data.forEach(r => { map[String(r.chi_nhanh).trim()] = r.tinh_thanh; });
    _branchMap = map;
    lsSet(LS_BRANCH_MAP, JSON.stringify(map));
  }
}

async function saveBranchMap(rows, code) {
  const sb = getSb();
  if (!sb) throw new Error("Chưa kết nối Supabase");
  const { error } = await sb.rpc('branches_upsert', { p_code: code, p_rows: rows });
  if (error) {
    if (/bad_code/.test(error.message)) { clearUploadCode(); throw new Error("Mã upload không đúng."); }
    throw new Error(error.message);
  }
  const map = {};
  rows.forEach(r => { map[r.chi_nhanh] = r.tinh_thanh; });
  _branchMap = { ..._branchMap, ...map };
  lsSet(LS_BRANCH_MAP, JSON.stringify(_branchMap));
}

// ─── MÃ UPLOAD (dùng chung key với Lập báo giá) ──────────────────────────────
const SS_UPLOAD_CODE = 'tsp_upload_code';
const LS_UPLOADER    = 'inv_uploader';
function getSavedUploadCode() { try { return sessionStorage.getItem(SS_UPLOAD_CODE) || ""; } catch { return ""; } }
function saveUploadCode(c)    { try { sessionStorage.setItem(SS_UPLOAD_CODE, c); } catch {} }
function clearUploadCode()    { try { sessionStorage.removeItem(SS_UPLOAD_CODE); } catch {} }
async function askUploadCode() {
  const saved = getSavedUploadCode();
  if (saved) return saved;
  const code = (window.prompt("Nhập mã upload:") || "").trim();
  if (!code) return "";
  const { data, error } = await getSb().rpc('upload_code_check', { p_code: code });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Mã upload không đúng.");
  saveUploadCode(code);
  return code;
}

const parseQty = v => { const n=parseFloat(String(v).replace(/[^0-9.-]/g,"")); return isNaN(n)?0:n; };
const fmtNum  = n => n.toLocaleString("vi-VN");
const parseCodes = t => [...new Set(t.split(/[\n,;，、\s]+/).map(c=>c.trim().toUpperCase()).filter(Boolean))];
const fmtTime = ts => new Date(ts).toLocaleString("vi-VN",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Asia/Ho_Chi_Minh"});

// ─── TRA CỨU (index theo mã hàng, dựng 1 lần mỗi khi dữ liệu đổi) ────────────
function buildSkuIndex(rows) {
  const idx = new Map();
  const pairs = new Map(); // "chiNhanh||tinhThanh" → { chiNhanh, tinhThanh }
  for (const r of rows) {
    const list = idx.get(r.maHang);
    if (list) list.push(r); else idx.set(r.maHang, [r]);
    const key = r.chiNhanh+"||"+r.tinhThanh;
    if (!pairs.has(key)) pairs.set(key, { chiNhanh:r.chiNhanh, tinhThanh:r.tinhThanh });
  }
  return { idx, pairs };
}

function computeLookup(items, index, keep = () => true) {
  const map = {};
  items.forEach(it => {
    map[it.maHang] = { rows:(index.idx.get(it.maHang)||[]).filter(keep), needQty:it.needQty, tenHang:it.tenHang, dvt:it.dvt };
  });
  return { items, map };
}

function computeCoverage(items, index, keepBranch = () => true) {
  const thresholds = {};
  items.forEach(it => { thresholds[it.maHang] = it.needQty==='' ? 0 : Number(it.needQty); });
  const codes = items.map(it=>it.maHang);
  const branchMap = {};
  for (const [key, b] of index.pairs) if (keepBranch(b)) branchMap[key] = { ...b, qtyMap:{} };
  codes.forEach(code => {
    for (const r of index.idx.get(code)||[]) {
      const b = branchMap[r.chiNhanh+"||"+r.tinhThanh];
      if (b) b.qtyMap[code] = (b.qtyMap[code]||0) + parseQty(r.cuoiKy);
    }
  });
  const rows = Object.values(branchMap).map(b => {
    const codeStatus = codes.map(c => ({
      code: c,
      qty: b.qtyMap[c]||0,
      needed: thresholds[c]||0,
      // Không nhập số lượng cần → chỉ cần còn hàng; chi nhánh tồn 0 không bao giờ tính là đủ
      ok: (b.qtyMap[c]||0) > 0 && (b.qtyMap[c]||0) >= (thresholds[c]||0),
      info: items.find(it=>it.maHang===c),
    }));
    const count = codeStatus.filter(cs=>cs.ok).length;
    return { ...b, codeStatus, count, hasAll: count===codes.length };
  }).sort((a,b) => b.count-a.count || a.chiNhanh.localeCompare(b.chiNhanh));
  return { codes, rows, items };
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const s = {
  app:     { minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Segoe UI','Tahoma',Arial,sans-serif", fontSize:13, display:"flex", flexDirection:"column" },
  layout:  { display:"flex", flex:1 },
  sidebar: { width:260, background:C.sidebarBg, borderRight:`1px solid #16304f`, display:"flex", flexDirection:"column", flexShrink:0 },
  sbHead:  { padding:"18px 16px 12px", borderBottom:"1px solid #16304f" },
  sbTitle: { fontSize:11, letterSpacing:"0.1em", textTransform:"uppercase", color:"#7ecfab", fontWeight:700, display:"flex", alignItems:"center", gap:8 },
  dot:     { width:7, height:7, borderRadius:"50%", background:"#7ecfab" },
  sbBody:  { flex:1, overflowY:"auto", padding:"8px 0", background:C.sidebarBg },
  sbFoot:  { padding:"12px 16px", borderTop:"1px solid #16304f", background:C.sidebarBg },
  main:    { flex:1, display:"flex", flexDirection:"column", overflow:"hidden" },
  topbar:  { borderBottom:`1px solid ${C.border}`, padding:"12px 28px", display:"flex", alignItems:"center", gap:12, background:C.headerBg, flexShrink:0, color:C.headerText },
  content: { flex:1, overflowY:"auto", padding:"20px 28px" },
  fileItem:(a)=>({ padding:"9px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, background:a?C.sidebarActiveBg:"transparent", borderLeft:`3px solid ${a?"#7ecfab":"transparent"}`, transition:"all 0.15s" }),
  fileName:(a)=>({ fontSize:12, color:a?C.sidebarActive:C.sidebarText, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }),
  fileMeta:{ fontSize:10, color:"#7a9bbf", marginTop:2 },
  tabs:    { display:"flex", borderBottom:`2px solid ${C.border}`, marginBottom:20, background:C.surface, borderRadius:"8px 8px 0 0", padding:"0 8px" },
  tab:     (a)=>({ padding:"10px 20px", fontSize:12, fontWeight:a?700:400, cursor:"pointer", color:a?C.accent:C.dim, borderBottom:`2px solid ${a?C.accent:"transparent"}`, background:"transparent", border:"none", fontFamily:"inherit", transition:"all 0.15s" }),
  dropzone:(a)=>({ border:`2px dashed ${a?C.accent:C.border}`, borderRadius:10, padding:"40px 24px", textAlign:"center", cursor:"pointer", background:a?C.accentBg:C.surface, transition:"all 0.2s", marginBottom:20 }),
  panel:   { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:20, marginBottom:16, boxShadow:"0 1px 4px #00000012" },
  label:   { fontSize:11, fontWeight:600, color:C.dim, marginBottom:6, display:"block" },
  textarea:{ width:"100%", background:"#f9fafb", border:`1px solid ${C.border}`, borderRadius:5, padding:"8px 12px", color:C.text, fontFamily:"inherit", fontSize:13, resize:"vertical", minHeight:60, outline:"none", boxSizing:"border-box", lineHeight:1.7 },
  select:  { background:"#f9fafb", border:`1px solid ${C.border}`, borderRadius:5, padding:"7px 10px", color:C.text, fontFamily:"inherit", fontSize:12, outline:"none" },
  filterRow:{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap", alignItems:"flex-end" },
  hint:    { fontSize:11, color:C.muted, marginTop:5 },
  btnRow:  { display:"flex", gap:8, marginTop:14, flexWrap:"wrap" },
  btnP:    (d)=>({ background:d?"#adb5bd":C.accent, color:"#ffffff", border:"none", borderRadius:5, padding:"8px 20px", fontSize:12, fontWeight:600, cursor:d?"not-allowed":"pointer", fontFamily:"inherit", flexShrink:0, boxShadow:d?"none":"0 2px 4px #0d7a4e44" }),
  btnS:    { background:"#f0f2f5", color:C.dim, border:`1px solid ${C.border}`, borderRadius:5, padding:"8px 14px", fontSize:12, cursor:"pointer", fontFamily:"inherit" },
  resHeader:{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 },
  resTitle: { fontSize:12, fontWeight:600, color:C.dim },
  badge:   (c="accent")=>({ background:C[c+"Bg"]||C.accentBg, color:C[c]||C.accent, border:`1px solid ${C[c+"Border"]||C.accentBorder}`, borderRadius:4, padding:"2px 9px", fontSize:11, fontWeight:600 }),
  card:    { background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, marginBottom:10, overflow:"hidden", boxShadow:"0 1px 4px #00000010" },
  cardHead:{ padding:"9px 15px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:10, background:C.surface2 },
  codeTag: { background:C.accentBg, color:C.accent, borderRadius:3, padding:"2px 8px", fontSize:11, fontWeight:700, flexShrink:0, border:`1px solid ${C.accentBorder}` },
  prodName:{ fontSize:12, flex:1, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  table:   { width:"100%", borderCollapse:"collapse", fontSize:11 },
  th:      { textAlign:"left", padding:"8px 15px", color:C.dim, fontSize:11, fontWeight:600, borderBottom:`1px solid ${C.border}`, userSelect:"none", background:C.surface2 },
  thSort:  { cursor:"pointer" },
  td:      { padding:"8px 15px", borderBottom:`1px solid ${C.borderLight}`, color:C.text },
  tdNum:   { padding:"8px 15px", borderBottom:`1px solid ${C.borderLight}`, color:C.text, fontWeight:700, textAlign:"right" },
  tdInput: { padding:"4px 8px", borderBottom:`1px solid ${C.border}18` },
  numInput:{ background:"#f9fafb", border:`1px solid ${C.border}`, borderRadius:4, padding:"5px 8px", color:C.text, fontFamily:"inherit", fontSize:12, width:90, textAlign:"right", outline:"none" },
  coverageCard:(f)=>({ background:f?C.accentBg:C.redBg, border:`1px solid ${f?C.accentBorder:C.redBorder}`, borderRadius:6, padding:"10px 15px", marginBottom:8, display:"flex", alignItems:"center", gap:10, boxShadow:"0 1px 3px #00000010" }),
  empty:   { textAlign:"center", padding:"60px 24px", color:C.muted, fontSize:13 },
  emptyIcon:{ fontSize:36, marginBottom:12 },
  modalOverlay:{ position:"fixed", inset:0, background:"#00000050", display:"flex", alignItems:"center", justifyContent:"center", zIndex:100 },
  modal:   { background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:28, width:360, maxWidth:"90vw", boxShadow:"0 8px 32px #00000030" },
  // Autocomplete
  searchWrap:{ position:"relative", marginBottom:10 },
  searchInput:{ width:"100%", background:"#f9fafb", border:`1px solid ${C.border}`, borderRadius:5, padding:"9px 36px 9px 13px", color:C.text, fontFamily:"inherit", fontSize:13, outline:"none", boxSizing:"border-box" },
  searchIcon:{ position:"absolute", right:11, top:"50%", transform:"translateY(-50%)", color:C.mutedLight, fontSize:14, pointerEvents:"none" },
  dropdown:{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, zIndex:50, background:C.surface, border:`1px solid ${C.border}`, borderRadius:6, maxHeight:240, overflowY:"auto", boxShadow:"0 4px 20px #00000022" },
  dropItem:(h)=>({ padding:"8px 13px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, background:h?C.accentBg:"transparent", borderBottom:`1px solid ${C.borderLight}` }),
  dropCode:{ fontSize:12, fontWeight:700, color:C.accent, flexShrink:0, minWidth:72 },
  dropName:{ fontSize:12, color:C.text, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  dropAdded:{ fontSize:10, color:C.mutedLight },
  dropEmpty:{ padding:"14px", fontSize:11, color:C.muted, textAlign:"center" },
};

// ─── CONFIRM MODAL ────────────────────────────────────────────────────────────
// ─── TRẠNG THÁI ĐỒNG BỘ ──────────────────────────────────────────────────────
function SyncBadge({ sync, rowCount }) {
  const dot = (color, pulse) => <span style={{ width:8, height:8, borderRadius:"50%", background:color, display:"inline-block", animation: pulse ? "pulse 1s infinite" : "none" }}/>;
  const n = v => (v||0).toLocaleString("vi-VN");
  const warn = sync.error ? <span title={sync.error} style={{ color:"#fbbf24", cursor:"help" }}>⚠</span> : null;
  switch (sync.state) {
    case "checking":    return <>{dot("#f59e0b", true)} Đang kiểm tra bản mới…</>;
    case "downloading": return <>{dot("#f59e0b", true)} Đang tải {sync.total ? `${n(sync.loaded)} / ${n(sync.total)}` : n(sync.loaded)} dòng…</>;
    case "saving":      return <>{dot("#60a5fa", true)} Đang lưu bản offline…</>;
    case "ready":       return <>{dot("#7ecfab")} Mới nhất · {n(rowCount)} dòng {warn}</>;
    case "uploading-elsewhere":
      return <span title="Trong lúc máy khác upload, bạn vẫn xem được bản trước đó">{dot("#f59e0b", true)} Máy khác đang upload — đang xem bản trước {warn}</span>;
    case "offline":     return <span title={sync.error}>{dot("#9aa5b4")} Mất kết nối — đang dùng bản offline</span>;
    case "error":       return <span title={sync.error} style={{ color:"#fca5a5", cursor:"help" }}>{dot("#f87171")} Lỗi đồng bộ: {String(sync.error||"").slice(0,60)}</span>;
    default:            return rowCount > 0 ? <>{dot("#7ecfab")} {n(rowCount)} dòng offline</> : null;
  }
}

// ─── XEM TRƯỚC & XÁC NHẬN UPLOAD ─────────────────────────────────────────────
const FIELD_LABELS = [
  ["maHang","Mã hàng"], ["tenHang","Tên hàng"], ["chiNhanh","Chi nhánh"], ["tinhThanh","Tỉnh thành"],
  ["maKho","Mã kho"], ["dvt","ĐVT"], ["cuoiKy","Tồn cuối kỳ"],
];

function UploadPreviewModal({ preview, prevMeta, onCancel, onConfirm }) {
  const { fileName, result } = preview;
  const { blockers=[], warnings=[], stats={}, columns={}, skipped=[], rows=[] } = result;
  const [ack, setAck] = useState(false);
  const [code, setCode] = useState(getSavedUploadCode);
  const [uploader, setUploader] = useState(() => { try { return localStorage.getItem(LS_UPLOADER) || ""; } catch { return ""; } });
  const blocked = blockers.length > 0;
  const canSubmit = !blocked && (warnings.length === 0 || ack) && code.trim() && uploader.trim();
  const box = (bg, border, color) => ({ background:bg, border:`1px solid ${border}`, color, borderRadius:6, padding:"8px 12px", fontSize:11, marginBottom:10, lineHeight:1.6 });

  return (
    <div style={s.modalOverlay}>
      <div style={{ ...s.modal, width:720, maxHeight:"90vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ fontSize:13, color:C.text, fontWeight:700, marginBottom:4 }}>Xem trước dữ liệu upload</div>
        <div style={{ fontSize:11, color:C.dim, marginBottom:14 }}>
          {fileName} · sheet <b>{result.sheetName}</b> · dòng tiêu đề {result.headerRow != null ? result.headerRow + 1 : "?"}
        </div>

        {blocked && (
          <div style={box(C.redBg, C.redBorder, C.red)}>
            <b>Không thể upload:</b>
            {blockers.map((b,i)=><div key={i}>• {b}</div>)}
          </div>
        )}
        {warnings.length > 0 && (
          <div style={box(C.amberBg, C.amberBorder, C.amber)}>
            <b>Cần kiểm tra:</b>
            {warnings.map((w,i)=><div key={i}>• {w}</div>)}
            {!blocked && (
              <label style={{ display:"flex", alignItems:"center", gap:6, marginTop:6, cursor:"pointer" }}>
                <input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> Tôi đã kiểm tra và vẫn muốn upload
              </label>
            )}
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:12 }}>
          <table style={{ ...s.table, fontSize:11 }}>
            <tbody>
              {FIELD_LABELS.map(([k,label]) => (
                <tr key={k}>
                  <td style={{ ...s.td, color:C.dim }}>{label}</td>
                  <td style={{ ...s.td, color: columns[k] ? C.text : C.muted }}>{columns[k] || "— không thấy —"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table style={{ ...s.table, fontSize:11 }}>
            <tbody>
              <tr><td style={{ ...s.td, color:C.dim }}>Dòng hợp lệ</td><td style={s.tdNum}>{fmtNum(stats.valid||0)}{prevMeta?.rowCount ? <span style={{ color:C.muted }}> (hiện tại {fmtNum(prevMeta.rowCount)})</span> : null}</td></tr>
              <tr><td style={{ ...s.td, color:C.dim }}>Dòng bị bỏ</td><td style={s.tdNum}>{fmtNum(stats.skipped||0)}</td></tr>
              <tr><td style={{ ...s.td, color:C.dim }}>Số chi nhánh</td><td style={s.tdNum}>{fmtNum(stats.branches||0)}</td></tr>
              <tr><td style={{ ...s.td, color:C.dim }}>Tổng tồn</td><td style={s.tdNum}>{fmtNum(stats.qtySum||0)}{prevMeta?.qtySum ? <span style={{ color:C.muted }}> (hiện tại {fmtNum(Number(prevMeta.qtySum))})</span> : null}</td></tr>
            </tbody>
          </table>
        </div>

        {rows.length > 0 && (
          <div style={{ overflowX:"auto", marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.dim, marginBottom:4 }}>10 dòng đầu sau khi đọc:</div>
            <table style={{ ...s.table, fontSize:10.5 }}>
              <thead><tr>{FIELD_LABELS.map(([k,l])=><th key={k} style={s.th}>{l}</th>)}</tr></thead>
              <tbody>
                {rows.slice(0,10).map((r,i)=>(
                  <tr key={i}>{FIELD_LABELS.map(([k])=><td key={k} style={k==="cuoiKy"?s.tdNum:s.td}>{k==="cuoiKy"?fmtNum(r[k]):r[k]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {skipped.length > 0 && (
          <div style={{ fontSize:10.5, color:C.dim, marginBottom:12 }}>
            Ví dụ dòng bị bỏ: {skipped.slice(0,5).map(x=>`dòng ${x.rowIndex + 1} (${x.reason})`).join("; ")}{skipped.length>5?"…":""}
          </div>
        )}

        {!blocked && (
          <div style={{ display:"flex", gap:10, marginBottom:16 }}>
            <input style={{ ...s.searchInput, flex:1 }} placeholder="Tên người upload" value={uploader} onChange={e=>setUploader(e.target.value)}/>
            <input style={{ ...s.searchInput, flex:1 }} type="password" placeholder="Mã upload" value={code} onChange={e=>setCode(e.target.value)}/>
          </div>
        )}
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button style={s.btnS} onClick={onCancel}>Hủy</button>
          {!blocked && <button style={s.btnP(!canSubmit)} disabled={!canSubmit} onClick={()=>onConfirm({ code:code.trim(), uploader:uploader.trim() })}>Upload {fmtNum(stats.valid||0)} dòng</button>}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ value, max, color=C.accent }) {
  const pct = max?Math.round(value/max*100):0;
  return <div style={{ background:C.border, borderRadius:3, height:4, width:80, overflow:"hidden" }}><div style={{ width:`${pct}%`, height:"100%", background:color, transition:"width 0.3s" }}/></div>;
}

// ─── PRODUCT SEARCH AUTOCOMPLETE ─────────────────────────────────────────────
// Bỏ dấu tiếng Việt để tìm "vien" ra "Viên", "duong" ra "Đường"
const foldText = s => String(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/đ/gi,"d").toLowerCase();

// catalog: [{ maHang, tenHang, dvt, key }] dựng 1 lần ở App, dùng chung cho cả 2 tab
function ProductSearch({ catalog, addedCodes, onAdd }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [hiIdx, setHiIdx] = useState(0);
  const inputRef = useRef();
  const dropRef  = useRef();

  const suggestions = useMemo(() => {
    const q = foldText(text.trim());
    if (!q) return [];
    return catalog.filter(p => p.key.includes(q)).slice(0,40);
  }, [text, catalog]);

  useEffect(() => { setHiIdx(0); }, [suggestions]);

  useEffect(() => {
    const h = e => { if (!dropRef.current?.contains(e.target) && !inputRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const add = (p) => {
    if (addedCodes.has(p.maHang)) return;
    onAdd(p);
    setText("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const hl = (str, q) => {
    const idx = str.toLowerCase().indexOf(q.toLowerCase());
    if (idx===-1) return str;
    return <>{str.slice(0,idx)}<span style={{color:C.accent,fontWeight:700}}>{str.slice(idx,idx+q.length)}</span>{str.slice(idx+q.length)}</>;
  };

  const handleKey = e => {
    if (!open||!suggestions.length) return;
    if (e.key==="ArrowDown"){e.preventDefault();setHiIdx(i=>Math.min(i+1,suggestions.length-1));}
    if (e.key==="ArrowUp")  {e.preventDefault();setHiIdx(i=>Math.max(i-1,0));}
    if (e.key==="Enter")    {e.preventDefault();if(suggestions[hiIdx])add(suggestions[hiIdx]);}
    if (e.key==="Escape")   setOpen(false);
  };

  return (
    <div style={s.searchWrap}>
      <input ref={inputRef} style={s.searchInput}
        placeholder="Gõ tên hoặc mã hàng để thêm vào danh sách..."
        value={text}
        onChange={e=>{setText(e.target.value);setOpen(true);}}
        onFocus={()=>{if(text)setOpen(true);}}
        onKeyDown={handleKey}
      />
      <span style={s.searchIcon}>⌕</span>
      {open && text.trim() && (
        <div ref={dropRef} style={s.dropdown}>
          {suggestions.length===0
            ? <div style={s.dropEmpty}>Không tìm thấy sản phẩm</div>
            : suggestions.map((p,i) => (
              <div key={p.maHang} style={s.dropItem(i===hiIdx)}
                onMouseEnter={()=>setHiIdx(i)}
                onMouseDown={e=>{e.preventDefault();add(p);}}>
                <span style={s.dropCode}>{hl(p.maHang,text)}</span>
                <span style={s.dropName}>{hl(p.tenHang,text)}</span>
                {addedCodes.has(p.maHang) && <span style={s.dropAdded}>✓ đã thêm</span>}
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

// ─── PRODUCT INPUT TABLE ──────────────────────────────────────────────────────
// items: [{maHang, tenHang, dvt, needQty}]
function ProductInputTable({ items, onChange }) {
  if (items.length === 0) return null;

  const setQty = (maHang, val) => {
    onChange(items.map(it => it.maHang===maHang ? {...it, needQty: val} : it));
  };
  const remove = (maHang) => onChange(items.filter(it => it.maHang !== maHang));

  return (
    <div style={{ marginTop:12, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>
      <table style={s.table}>
        <thead>
          <tr style={{ background:C.surface2, borderBottom:`1px solid ${C.border}` }}>
            <th style={s.th}>Mã hàng</th>
            <th style={s.th}>Tên hàng</th>
            <th style={s.th}>ĐVT</th>
            <th style={{ ...s.th, textAlign:"right" }}>Số lượng cần</th>
            <th style={{ ...s.th, width:32 }}></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.maHang} style={{ background: i%2===0?C.surface:"#f8fafc" }}>
              <td style={s.td}><span style={s.codeTag}>{it.maHang}</span></td>
              <td style={{ ...s.td, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{it.tenHang||"—"}</td>
              <td style={s.td}>{it.dvt||"—"}</td>
              <td style={s.tdInput}>
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <input
                    type="number" min={0} style={s.numInput}
                    value={it.needQty ?? ""}
                    placeholder="0"
                    onChange={e => setQty(it.maHang, e.target.value===''?'':Number(e.target.value))}
                  />
                </div>
              </td>
              <td style={{ ...s.td, textAlign:"center", padding:"4px 8px" }}>
                <span style={{ cursor:"pointer", color:C.muted, fontSize:14 }} onClick={()=>remove(it.maHang)}>×</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── SORTABLE TABLE ───────────────────────────────────────────────────────────
const COLS = [
  { key:"chiNhanh",  label:"Chi nhánh",  num:false },
  { key:"tinhThanh", label:"Tỉnh thành", num:false },
  { key:"maKho",     label:"Mã kho",     num:false },
  { key:"dvt",       label:"ĐVT",        num:false },
  { key:"cuoiKy",    label:"Cuối kỳ",    num:true  },
];

function SortableResultTable({ rows, needQty }) {
  const [sortKey, setSortKey] = useState("cuoiKy");
  const [sortDir, setSortDir] = useState("desc");

  const toggleSort = (key) => {
    if (sortKey===key) setSortDir(d=>d==="asc"?"desc":"asc");
    else { setSortKey(key); setSortDir(COLS.find(c=>c.key===key)?.num ? "desc":"asc"); }
  };

  const sorted = useMemo(() => {
    const col = COLS.find(c=>c.key===sortKey);
    return [...rows].sort((a,b) => {
      const av = col?.num ? parseQty(a[sortKey]) : String(a[sortKey]||"");
      const bv = col?.num ? parseQty(b[sortKey]) : String(b[sortKey]||"");
      const cmp = typeof av==="number" ? av-bv : av.localeCompare(bv);
      return sortDir==="asc" ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  const arrow = (key) => {
    if (sortKey!==key) return <span style={{ opacity:0.25, marginLeft:4 }}>↕</span>;
    return <span style={{ color:C.accent, marginLeft:4 }}>{sortDir==="asc"?"↑":"↓"}</span>;
  };

  const thS = (key) => ({
    ...s.th, ...s.thSort,
    color: sortKey===key ? C.accent : C.dim,
    background: sortKey===key ? C.accentBg : C.surface2,
  });

  return (
    <table style={s.table}>
      <thead>
        <tr>
          {COLS.map(c => (
            <th key={c.key}
              style={{ ...thS(c.key), textAlign: c.num?"right":"left" }}
              onClick={()=>toggleSort(c.key)}>
              {c.label}{arrow(c.key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r,i) => {
          const qty = parseQty(r.cuoiKy);
          const meetsReq = needQty == null || needQty === '' || qty >= Number(needQty);
          return (
            <tr key={i} style={{ opacity: meetsReq ? 1 : 0.45 }}>
              <td style={s.td}>{r.chiNhanh||"—"}</td>
              <td style={s.td}>{r.tinhThanh||"—"}</td>
              <td style={s.td}>{r.maKho||"—"}</td>
              <td style={s.td}>{r.dvt||"—"}</td>
              <td style={{ ...s.tdNum, color: meetsReq ? C.accent : C.red }}>
                {fmtNum(qty)}
                {!meetsReq && <span style={{ fontSize:9, color:C.red, marginLeft:4 }}>▼</span>}
              </td>
            </tr>
          );
        })}
        {rows.length > 1 && (
          <tr style={{ background:C.surface2 }}>
            <td style={{ ...s.td, color:C.accent, fontWeight:700 }} colSpan={4}>Tổng tồn kho</td>
            <td style={{ ...s.tdNum, color:C.accent }}>{fmtNum(rows.reduce((s,r)=>s+parseQty(r.cuoiKy),0))}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [activeRows, setActiveRows]   = useState([]);
  const [meta, setMeta]               = useState(null); // stock_meta của bản đang hiển thị
  const [reading, setReading]         = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ done:0, total:0 });
  const [preview, setPreview]         = useState(null); // { fileName, result } — chờ xác nhận upload
  const [dragging, setDragging]       = useState(false);
  const fileRef = useRef();
  const [tab, setTab] = useState("lookup");

  // Lookup: items = [{maHang,tenHang,dvt,needQty}]
  const [lookupItems, setLookupItems] = useState([]);
  const [filterProvince, setFilterProvince] = useState("");
  const [filterBranch, setFilterBranch]     = useState("");
  const [results, setResults]   = useState(null);

  // Coverage: items = [{maHang,tenHang,dvt,needQty}]
  const [coverItems, setCoverItems]   = useState([]);
  const [exportToast, setExportToast] = useState("");
  const [coverageResults, setCoverageResults] = useState(null);

  // Trạng thái đồng bộ do stockSync báo: idle|checking|downloading|saving|ready|offline|error|uploading-elsewhere
  const [sync, setSync] = useState({ state:"idle" });
  const [provinces, setProvinces] = useState([]);
  const [branches,  setBranches]  = useState([]);
  const [skuIndex, setSkuIndex] = useState(() => buildSkuIndex([]));
  const skuIndexRef = useRef(skuIndex); // để _applyRequest đọc index mà không cần effect

  const _applyRows = useCallback((rows, newMeta) => {
    const index = buildSkuIndex(rows);
    skuIndexRef.current = index;
    setSkuIndex(index);
    setActiveRows(rows);
    if (newMeta !== undefined) setMeta(newMeta);
    setProvinces([...new Set(rows.map(r=>r.tinhThanh).filter(Boolean))].sort());
    setBranches([...new Set(rows.map(r=>r.chiNhanh).filter(Boolean))].sort((a,b)=>
      isNaN(a)||isNaN(b)?a.localeCompare(b):Number(a)-Number(b)));
  }, []);

  const syncBusy = ["checking","downloading","saving"].includes(sync.state);

  const forceResync = useCallback(async () => {
    try {
      const r = await syncIfStale({ force:true });
      _applyRows(r.rows, r.meta);
    } catch {} // lỗi đã được báo qua trạng thái sync
  }, [_applyRows]);

  const _applyRequest = useCallback((raw) => {
    if (!Array.isArray(raw) || !raw.length) return;
    const mapped = raw.map(it => ({
      maHang:  String(it.maHang||"").toUpperCase().trim(),
      tenHang: String(it.tenHang||"").trim(),
      dvt:     String(it.dvt||"").trim(),
      needQty: it.needQty != null ? String(it.needQty) : "",
    })).filter(it => it.maHang);
    if (!mapped.length) return;
    // Kết quả tự tính khi dữ liệu sẵn sàng (effect bên dưới)
    setLookupItems(mapped);
    setCoverItems(mapped);
    setTab("lookup");
  }, []);

  useEffect(() => {
    let alive = true;
    initStockSync({ getSb, onStatus: st => { if (alive) setSync(st); } });
    loadBranchMap()
      .then(() => { if (alive) setBranchCount(Object.keys(_branchMap).length); })
      .catch(e => console.warn("Không tải được bảng chi nhánh:", e.message));

    // Đọc từ URL params (mở tab mới hoặc navigate tab cũ đều đọc đúng)
    const urlP = new URLSearchParams(window.location.search);
    const orderParam = urlP.get('order');
    const skuParam   = urlP.get('sku');
    if (skuParam) {
      // ?sku=[{maHang,tenHang,dvt,needQty}] — tra cứu trực tiếp, không cần Supabase
      // URLSearchParams đã giải mã 1 lần; chỉ giải mã thêm nếu link cũ bị mã hoá 2 lần
      // (tên như "Cồn 70%" sẽ làm decodeURIComponent ném lỗi)
      let items = null;
      try { items = JSON.parse(skuParam); } catch {
        try { items = JSON.parse(decodeURIComponent(skuParam)); } catch {}
      }
      if (Array.isArray(items) && items.length) _applyRequest(items);
      else setExportToast("Link tra cứu không hợp lệ");
    } else if (orderParam) {
      // ?order=ECMxxxxxx — lấy cart từ Supabase orders table
      const sb = getSb();
      if (sb) {
        sb.from('orders').select('cart').eq('id', orderParam).single()
          .then(({ data, error }) => {
            if (error || !Array.isArray(data?.cart)) { if (alive) setExportToast(`Không tải được đơn ${orderParam}`); return; }
            const items = data.cart
              .filter(p => p.sku && !p.promo)
              .map(p => ({ maHang: p.sku, tenHang: p.name || p.sku, dvt: p.unit || '', needQty: p.qty || 1 }));
            if (items.length) _applyRequest(items);
          });
      }
    }

    // Hiện ngay bản offline, rồi kiểm tra phiên bản trên máy chủ
    (async () => {
      try {
        const cached = await loadCached();
        if (alive && cached) _applyRows(cached.rows, cached.meta);
      } catch (e) { console.warn("Không đọc được bản offline:", e.message); }
      try {
        const r = await syncIfStale();
        if (!alive) return;
        if (r.changed || skuIndexRef.current.idx.size === 0) _applyRows(r.rows, r.meta);
        else setMeta(r.meta);
      } catch {} // lỗi đã được báo qua trạng thái sync
    })();

    // Tab khác vừa đồng bộ/upload xong → nạp lại từ cache
    const unsub = subscribe(async () => {
      const cached = await loadCached().catch(() => null);
      if (!alive || !cached) return;
      _applyRows(cached.rows, cached.meta);
      // Tab khác vừa upload xong → không còn "máy khác đang upload"
      setSync(st => st.state === "uploading-elsewhere" ? { ...st, state:"ready", ...cached.meta } : st);
    });
    return () => { alive = false; unsub(); };
  }, [_applyRows, _applyRequest]);

  // Kết quả luôn tự cập nhật: khi thêm/bớt mã, sửa số lượng cần, đổi bộ lọc, hoặc có dữ liệu mới
  useEffect(() => {
    const keep = b => (!filterProvince||b.tinhThanh===filterProvince)&&(!filterBranch||b.chiNhanh===filterBranch);
    const ready = skuIndex.idx.size > 0;
    setResults(ready && lookupItems.length ? computeLookup(lookupItems, skuIndex, keep) : null);
    setCoverageResults(ready && coverItems.length ? computeCoverage(coverItems, skuIndex, keep) : null);
  }, [lookupItems, coverItems, skuIndex, filterProvince, filterBranch]);

  // Tự kiểm tra bản mới: mỗi 2 phút khi tab đang mở, và mỗi khi người dùng quay lại tab
  // (chỉ đọc 1 dòng stock_meta; chỉ tải khi phiên bản đổi)
  const pollingRef = useRef(false);
  const lastPollRef = useRef(0);
  useEffect(() => {
    const poll = async () => {
      if (pollingRef.current || document.visibilityState !== "visible") return;
      if (Date.now() - lastPollRef.current < 20000) return;
      pollingRef.current = true; lastPollRef.current = Date.now();
      try {
        const r = await syncIfStale({ quiet:true });
        if (r.changed) _applyRows(r.rows, r.meta); else setMeta(r.meta);
      } catch {} // lỗi đã được báo qua trạng thái sync
      pollingRef.current = false;
    };
    const timer = setInterval(poll, 120000);
    const onVisible = () => { if (document.visibilityState === "visible") poll(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [_applyRows]);

  // Danh mục mã hàng dựng 1 lần: map tra tên/ĐVT theo mã + danh sách gợi ý tìm không dấu
  const { catalog, catalogList } = useMemo(() => {
    const map = {}, list = [];
    for (const [code, rows] of skuIndex.idx) {
      const { tenHang, dvt } = rows[0];
      map[code] = { tenHang, dvt };
      list.push({ maHang:code, tenHang, dvt, key:foldText(code+" "+tenHang) });
    }
    return { catalog:map, catalogList:list };
  }, [skuIndex]);

  // ── Xuất sang v2.html (Lập báo giá) ──
  const exportToInvoice = (items) => {
    if (!items.length) return;
    const payload = items.map(it => ({
      maHang:  it.maHang,
      tenHang: it.tenHang || it.maHang,
      dvt:     it.dvt || '',
      needQty: it.needQty !== '' && it.needQty != null ? Number(it.needQty) : 1,
    }));
    lsSet('tsp_order_request', JSON.stringify(payload));
    // v2.html nằm cùng cấp hoặc một cấp trên — tự detect theo URL hiện tại
    const base = window.location.href
      .replace(/\/inventory-lookup(\/.*)?$/, '/')
      .replace(/\/$/, '');
    window.open(base + '/index.html', '_blank');
    setExportToast(`Đã gửi ${payload.length} SP → Lập báo giá`);
    setTimeout(() => setExportToast(""), 3000);
  };

  // Bước 1: đọc & kiểm tra file → mở màn hình xem trước (chưa ghi gì lên máy chủ)
  const handleUpload = useCallback((file) => {
    if (!file || uploading || reading) return;
    setReading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        await new Promise(r => setTimeout(r, 50));
        // raw:true — file .xls xuất từ ERP thực chất là HTML; không để SheetJS tự đoán số ("1.234", "00100")
        const wb = XLSX.read(e.target.result, { type:"array", raw:true });
        const previousMeta = meta ? { ...meta, branches:branches.length } : null;
        const result = analyzeWorkbook(wb, XLSX, { branchMap:_branchMap, previousMeta });
        if (result.blockers.length === 0 && result.rows.length > 0) {
          const hash = await contentHashOfRows(result.rows).catch(() => null);
          if (meta?.contentHash && hash === meta.contentHash) {
            result.blockers.push(`File này giống hệt bản đang dùng (cập nhật ${fmtTime(meta.publishedAt)}${meta.uploader ? " bởi " + meta.uploader : ""}) — không cần upload lại.`);
          } else if (meta && !meta.contentHash && meta.rowCount === result.stats.valid && Math.abs(Number(meta.qtySum) - result.stats.qtySum) < 0.5) {
            result.warnings.push("Số dòng và tổng tồn trùng khớp bản đang dùng — có thể là cùng một file.");
          }
        }
        setPreview({ fileName:file.name, result });
      } catch(err) { alert("Không đọc được file Excel\n"+err.message); }
      setReading(false);
    };
    reader.onerror = () => { setReading(false); alert("Không đọc được file"); };
    reader.readAsArrayBuffer(file);
  }, [uploading, reading, meta, branches]);

  // Bước 2: người dùng xác nhận → upload vào bảng tạm rồi chuyển sang bảng chính
  const confirmUpload = useCallback(async ({ code, uploader }) => {
    const { fileName, result } = preview;
    setPreview(null);
    setUploading(true);
    setUploadProgress({ done:0, total:result.rows.length });
    try {
      const newMeta = await uploadStock({
        code, rows:result.rows, uploader, fileName,
        onProgress:(done, total) => setUploadProgress({ done, total }),
      });
      saveUploadCode(code);
      lsSet(LS_UPLOADER, uploader);
      _applyRows(result.rows, newMeta);
      setResults(null); setCoverageResults(null);
      alert(`Đã cập nhật ${fmtNum(newMeta.rowCount ?? result.rows.length)} dòng tồn kho.`);
    } catch(err) {
      if (err.code === "bad_code") {
        clearUploadCode();
        setPreview({ fileName, result }); // mở lại để nhập lại mã, không phải đọc lại file
      }
      alert("Upload không thành công — dữ liệu đang dùng trên máy chủ không bị thay đổi.\n\n"+err.message);
    }
    setUploading(false);
  }, [preview, _applyRows]);


  const branchFileRef = useRef();
  const [branchUploading, setBranchUploading] = useState(false);
  const [branchCount, setBranchCount] = useState(() => Object.keys(_branchMap).length);

  const handleBranchUpload = useCallback(async (file) => {
    if (!file) return;
    setBranchUploading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const wb = XLSX.read(e.target.result, { type:"array" });
        const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:"" });
        const norm = s => normHeader(s).replace(/\s+/g,"");
        // Chọn cột 1 lần: khớp chính xác trước, sau đó mới "chứa"; bỏ cột mã ("Mã chi nhánh")
        const keys = Object.keys(raw[0] || {});
        const pick = ps => keys.find(k => ps.some(p => norm(k)===norm(p)))
          || keys.find(k => !norm(k).startsWith("ma") && ps.some(p => norm(k).includes(norm(p))));
        const kCN = pick(["chi nhanh","ten chi nhanh","branch"]), kTT = pick(["tinh thanh","tinh","province"]);
        const rows = (kCN && kTT ? raw : []).map(r => ({ chi_nhanh:String(r[kCN]).trim(), tinh_thanh:String(r[kTT]).trim() }))
          .filter(r => r.chi_nhanh && r.tinh_thanh);
        if (!rows.length) { alert("Không tìm thấy cột chi nhánh / tỉnh thành"); setBranchUploading(false); return; }
        const code = await askUploadCode();
        if (!code) { setBranchUploading(false); return; }
        await saveBranchMap(rows, code);
        setBranchCount(Object.keys(_branchMap).length);
        alert(`Đã cập nhật ${rows.length} chi nhánh`);
      } catch(err) { alert("Lỗi: " + err.message); }
      setBranchUploading(false);
    };
    reader.readAsArrayBuffer(file);
  }, []);

  // Add product to lookup
  const addLookupItem = (p) => {
    if (lookupItems.find(it=>it.maHang===p.maHang)) return;
    setLookupItems(prev => [...prev, { maHang:p.maHang, tenHang:p.tenHang, dvt:p.dvt, needQty:'' }]);
  };
  // Also handle manual code entry textarea
  const [manualQuery, setManualQuery] = useState("");
  const addManualCodes = () => {
    const codes = parseCodes(manualQuery);
    const toAdd = codes.filter(c => !lookupItems.find(it=>it.maHang===c));
    const newItems = toAdd.map(c => {
      const info = catalog[c] || { tenHang:"", dvt:"" };
      return { maHang:c, tenHang:info.tenHang, dvt:info.dvt, needQty:'' };
    });
    setLookupItems(prev => [...prev, ...newItems]);
    setManualQuery("");
  };

  const addCoverItem = (p) => {
    if (coverItems.find(it=>it.maHang===p.maHang)) return;
    setCoverItems(prev => [...prev, { maHang:p.maHang, tenHang:p.tenHang, dvt:p.dvt, needQty:'' }]);
  };
  const [coverManual, setCoverManual] = useState("");
  const addCoverManual = () => {
    const codes = parseCodes(coverManual);
    const toAdd = codes.filter(c => !coverItems.find(it=>it.maHang===c));
    const newItems = toAdd.map(c => {
      const info = catalog[c] || { tenHang:"", dvt:"" };
      return { maHang:c, tenHang:info.tenHang, dvt:info.dvt, needQty:'' };
    });
    setCoverItems(prev => [...prev, ...newItems]);
    setCoverManual("");
  };



  const datasetName = meta?.fileName ? meta.fileName.replace(/.(xlsx|xls)$/i,"") : "Dữ liệu Supabase";
  const lookupAddedCodes = useMemo(()=>new Set(lookupItems.map(it=>it.maHang)), [lookupItems]);
  const coverAddedCodes  = useMemo(()=>new Set(coverItems.map(it=>it.maHang)), [coverItems]);
  const foundCount = results ? Object.values(results.map).filter(v=>v.rows.length>0).length : 0;
  const fullCoverageCount = coverageResults?.rows.filter(r=>r.hasAll).length||0;

  return (
    <div style={s.app}>
      <div style={s.layout}>

        {/* ── SIDEBAR ── */}
        <div style={s.sidebar}>
          <div style={s.sbHead}>
            <div style={s.sbTitle}><div style={s.dot}/>Kho dữ liệu</div>
            <div style={{ fontSize:10, color:"#7a9bbf", marginTop:4 }}>Lưu trên Supabase · có bản offline</div>
            <div style={{ fontSize:10, color:"#5a8aaa", marginTop:2 }}>Upload mới → thay toàn bộ</div>
          </div>
          <div style={s.sbBody}>
            {activeRows.length===0 && !meta?.version
              ? <div style={{ padding:"24px 16px", textAlign:"center", color:"#7a9bbf", fontSize:11 }}>{syncBusy ? "Đang tải dữ liệu…" : "Chưa có dữ liệu"}</div>
              : (
              <div style={s.fileItem(true)}>
                <span style={{ fontSize:16 }}>☁️</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={s.fileName(true)}>{datasetName}</div>
                  <div style={{ fontSize:10, color:"#7ecfab" }}>{activeRows.length.toLocaleString("vi-VN")} dòng · có bản offline</div>
                  {meta?.publishedAt && <div style={{ ...s.fileMeta, fontSize:9 }}>Cập nhật {fmtTime(meta.publishedAt)}{meta.uploader ? ` · ${meta.uploader}` : ""}</div>}
                </div>
              </div>
            )}
          </div>
          <div style={s.sbFoot}>
            <div style={{ border:`2px dashed ${dragging?"#7ecfab":"#2d5490"}`, borderRadius:8, padding:"16px 12px", marginBottom:0, textAlign:"center", cursor:(reading||uploading)?"default":"pointer", background:dragging?"#1a4a7a":"#1a3257", transition:"all 0.2s" }}
              onDragOver={e=>{e.preventDefault();if(!reading&&!uploading)setDragging(true);}}
              onDragLeave={()=>setDragging(false)}
              onDrop={e=>{e.preventDefault();setDragging(false);if(!reading&&!uploading)handleUpload(e.dataTransfer.files[0]);}}
              onClick={()=>{if(!reading&&!uploading)fileRef.current.click();}}>
              <div style={{ fontSize:18, marginBottom:4 }}>📂</div>
              <div style={{ fontSize:10, color:C.dim, lineHeight:1.6 }}>
                {uploading
                  ? <div style={{textAlign:"center"}}>
                      <span style={{color:"#7ecfab", fontWeight:700}}>Đang upload...</span>
                      {uploadProgress.total>0 && <>
                        <br/>
                        <span style={{color:"#f59e0b", fontSize:11}}>
                          {uploadProgress.done.toLocaleString("vi-VN")} / {uploadProgress.total.toLocaleString("vi-VN")} dòng
                        </span>
                        <div style={{marginTop:6, background:"#16304f", borderRadius:4, height:4, overflow:"hidden"}}>
                          <div style={{height:"100%", background:"#7ecfab", width:`${Math.round(uploadProgress.done/uploadProgress.total*100)}%`, transition:"width .3s"}}/>
                        </div>
                      </>}
                    </div>
                  : reading
                  ? <span style={{color:"#f59e0b", fontWeight:600}}>⏳ Đang đọc file… (file lớn có thể mất 10–20 giây)</span>
                  : <><span style={{color:"#c8e8ff", fontWeight:600}}>Cập nhật data</span><br/><span style={{color:"#7a9bbf"}}>Tải tồn kho mới trừ tích xuất ERP</span></>
                }
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={e=>{handleUpload(e.target.files[0]); e.target.value="";}}/>
            </div>
            {/* Upload bảng chi nhánh */}
            <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #16304f" }}>
              <div style={{ fontSize:10, color:"#7a9bbf", marginBottom:6 }}>
                🗺 Chi nhánh → Tỉnh thành
                {branchCount > 0 && <span style={{ color:"#7ecfab", marginLeft:6 }}>{branchCount} CN</span>}
              </div>
              <button
                onClick={() => branchFileRef.current.click()}
                disabled={branchUploading}
                style={{ width:"100%", padding:"6px 8px", background:"#16304f", border:"1px solid #1e4a7a", borderRadius:6, color:"#c8e8ff", fontSize:11, cursor:"pointer" }}>
                {branchUploading ? "Đang upload..." : "📂 Upload Excel chi nhánh"}
              </button>
              <input ref={branchFileRef} type="file" accept=".xlsx,.xls" style={{ display:"none" }} onChange={e=>{handleBranchUpload(e.target.files[0]); e.target.value="";}}/>
            </div>
          </div>
        </div>

        {/* ── MAIN ── */}
        <div style={s.main}>
          <div style={s.topbar}>
            <span style={{ fontSize:12, fontWeight:700, color:"#7ecfab", letterSpacing:"0.08em", textTransform:"uppercase" }}>📦 Tra cứu tồn kho</span>
            {activeRows.length>0 && <>
              <span style={{ color:"#7a9bbf", fontSize:12 }}>·</span>
              <span style={{ fontSize:12, color:"#c8e8ff", fontWeight:600 }}>{datasetName}</span>
              <span style={{ fontSize:11, color:"#7a9bbf" }}>{activeRows.length.toLocaleString("vi-VN")} dòng</span>
            </>}
            <div style={{ marginLeft:"auto", fontSize:11, color:"#7a9bbf", display:"flex", alignItems:"center", gap:8 }}>
              {meta?.publishedAt && (
                <span style={{ fontSize:10, color:"#5a8aaa" }} title="Thời điểm bản dữ liệu đang xem được đưa lên máy chủ">
                  📅 Data: {fmtTime(meta.publishedAt)}
                </span>
              )}
              <SyncBadge sync={sync} rowCount={activeRows.length}/>
              <button
                onClick={forceResync}
                disabled={syncBusy || uploading}
                title="Tải lại toàn bộ từ Supabase"
                style={{ padding:"3px 8px", background:"#16304f", border:"1px solid #3a6a9a", borderRadius:4, color: syncBusy ? "#3a6a9a" : "#7ecfab", fontSize:10, fontWeight:700, cursor: syncBusy ? "default" : "pointer" }}
              >&#x21BA; Làm mới</button>
            </div>
          </div>

          <div style={s.content}>
            {activeRows.length===0 ? (
              <div style={s.empty}><div style={s.emptyIcon}>{syncBusy ? "⏳" : "📭"}</div><div>
                {syncBusy ? "Đang tải dữ liệu tồn kho…" : sync.state==="offline" ? "Không kết nối được máy chủ và chưa có bản offline" : "Chưa có dữ liệu tồn kho"}
                <br/><span style={{fontSize:11,color:C.muted}}>{syncBusy ? "Lần đầu có thể mất vài phút" : "Upload file Excel ở cột bên trái để bắt đầu"}</span>
              </div></div>
            ) : (
              <>
                <div style={s.tabs}>
                  <button style={s.tab(tab==="lookup")} onClick={()=>setTab("lookup")}>🔍 Tra cứu mã hàng</button>
                  <button style={s.tab(tab==="coverage")} onClick={()=>setTab("coverage")}>🗺 Kiểm tra chi nhánh</button>
                </div>

                {/* ═══ TAB: LOOKUP ═══ */}
                {tab==="lookup" && (
                  <>
                    <div style={s.panel}>
                      <label style={s.label}>Tìm theo tên hàng / mã hàng</label>
                      <ProductSearch catalog={catalogList} addedCodes={lookupAddedCodes} onAdd={addLookupItem}/>

                      {/* Manual code entry */}
                      <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
                        <textarea style={{ ...s.textarea, flex:1, minHeight:44, resize:"none" }}
                          placeholder="Hoặc nhập mã thẳng: 933936, 933942..."
                          value={manualQuery}
                          onChange={e=>setManualQuery(e.target.value)}
                          onKeyDown={e=>{if(e.ctrlKey&&e.key==="Enter")addManualCodes();}}
                        />
                        <button style={{ ...s.btnS, whiteSpace:"nowrap", alignSelf:"stretch" }} onClick={addManualCodes} disabled={!manualQuery.trim()}>
                          + Thêm
                        </button>
                      </div>
                      <div style={s.hint}>Ctrl+Enter để thêm nhanh</div>

                      {/* Product input table */}
                      <ProductInputTable items={lookupItems} onChange={setLookupItems}/>

                      {/* Filters */}
                      <div style={{ ...s.filterRow, marginTop:16 }}>
                        <div>
                          <label style={{ ...s.label, marginBottom:4 }}>Lọc tỉnh thành</label>
                          <select style={s.select} value={filterProvince} onChange={e=>setFilterProvince(e.target.value)}>
                            <option value="">Tất cả tỉnh thành</option>
                            {provinces.map(p=><option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ ...s.label, marginBottom:4 }}>Lọc chi nhánh</label>
                          <select style={s.select} value={filterBranch} onChange={e=>setFilterBranch(e.target.value)}>
                            <option value="">Tất cả chi nhánh</option>
                            {branches.map(b=><option key={b} value={b}>{b}</option>)}
                          </select>
                        </div>
                        {(filterProvince||filterBranch) && (
                          <button style={{ ...s.btnS, alignSelf:"flex-end" }} onClick={()=>{setFilterProvince("");setFilterBranch("");}}>✕ Bỏ lọc</button>
                        )}
                      </div>

                      {lookupItems.length>0 && (
                        <div style={s.btnRow}>
                          <button style={s.btnS} onClick={()=>{setLookupItems([]);setManualQuery("");}}>Xóa tất cả</button>
                        </div>
                      )}
                    </div>

                    {/* Results */}
                    {results && (
                      <>
                        <div style={s.resHeader}>
                          <span style={s.resTitle}>{results.items.length} mã · {filterProvince||filterBranch?"đã lọc":"tất cả chi nhánh"}</span>
                          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                            <button
                              onClick={() => exportToInvoice(results.items)}
                              style={{ background:C.accentBg, color:C.accent, border:`1px solid ${C.accentBorder}`, borderRadius:5, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>
                              📋 Tạo đơn báo giá
                            </button>
                            <span style={s.badge(foundCount===results.items.length?"accent":"amber")}>
                              {foundCount}/{results.items.length} mã có tồn kho
                            </span>
                          </div>
                        </div>

                        {results.items.map(it => {
                          const { rows, needQty } = results.map[it.maHang];
                          const hasNeed = needQty!=='' && needQty!=null;
                          const qualifiedRows = hasNeed ? rows.filter(r=>parseQty(r.cuoiKy)>=Number(needQty)) : rows;
                          return (
                            <div key={it.maHang} style={s.card}>
                              <div style={s.cardHead}>
                                <span style={s.codeTag}>{it.maHang}</span>
                                <span style={s.prodName}>{it.tenHang||"—"}</span>
                                {hasNeed && (
                                  <span style={{ ...s.badge("amber"), fontSize:10, flexShrink:0 }}>
                                    cần ≥ {fmtNum(Number(needQty))} {it.dvt}
                                  </span>
                                )}
                                <span style={{ fontSize:10, color:C.mutedLight, flexShrink:0, marginLeft:4 }}>
                                  {hasNeed ? `${qualifiedRows.length}/${rows.length} CN đủ hàng` : `${rows.length} chi nhánh`}
                                </span>
                              </div>
                              {rows.length===0 ? (
                                <div style={{ padding:"11px 15px", fontSize:11, color:C.red }}>⚠ Không tìm thấy{filterProvince||filterBranch?" trong phạm vi lọc":""}</div>
                              ) : (
                                <SortableResultTable rows={rows} needQty={hasNeed?needQty:null}/>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}

                    {!results && <div style={s.empty}><div style={s.emptyIcon}>🔍</div>Thêm mã hàng — kết quả hiện ngay</div>}
                  </>
                )}

                {/* ═══ TAB: COVERAGE ═══ */}
                {tab==="coverage" && (
                  <>
                    <div style={s.panel}>
                      <label style={s.label}>Thêm mã hàng cần kiểm tra</label>
                      <ProductSearch catalog={catalogList} addedCodes={coverAddedCodes} onAdd={addCoverItem}/>

                      <div style={{ display:"flex", gap:8, alignItems:"flex-start" }}>
                        <textarea style={{ ...s.textarea, flex:1, minHeight:44, resize:"none" }}
                          placeholder="Hoặc nhập mã thẳng: 933936, 933942..."
                          value={coverManual}
                          onChange={e=>setCoverManual(e.target.value)}
                          onKeyDown={e=>{if(e.ctrlKey&&e.key==="Enter")addCoverManual();}}
                        />
                        <button style={{ ...s.btnS, whiteSpace:"nowrap", alignSelf:"stretch" }} onClick={addCoverManual} disabled={!coverManual.trim()}>
                          + Thêm
                        </button>
                      </div>
                      <div style={s.hint}>Nhập số lượng cần → chỉ tính chi nhánh tồn ≥ số lượng đó</div>

                      <ProductInputTable items={coverItems} onChange={setCoverItems}/>

                      {/* Filters */}
                      <div style={{ ...s.filterRow, marginTop:16 }}>
                        <div>
                          <label style={{ ...s.label, marginBottom:4 }}>Lọc tỉnh thành</label>
                          <select style={s.select} value={filterProvince} onChange={e=>setFilterProvince(e.target.value)}>
                            <option value="">Tất cả tỉnh thành</option>
                            {provinces.map(p=><option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ ...s.label, marginBottom:4 }}>Lọc chi nhánh</label>
                          <select style={s.select} value={filterBranch} onChange={e=>setFilterBranch(e.target.value)}>
                            <option value="">Tất cả chi nhánh</option>
                            {branches.map(b=><option key={b} value={b}>{b}</option>)}
                          </select>
                        </div>
                        {(filterProvince||filterBranch) && (
                          <button style={{ ...s.btnS, alignSelf:"flex-end" }} onClick={()=>{setFilterProvince("");setFilterBranch("");}}>✕ Bỏ lọc</button>
                        )}
                      </div>

                      {coverItems.length>0 && (
                        <div style={s.btnRow}>
                          <button style={s.btnS} onClick={()=>{setCoverItems([]);setCoverManual("");}}>Xóa tất cả</button>
                        </div>
                      )}
                    </div>

                    {coverageResults && (
                      <>
                        <div style={s.resHeader}>
                          <span style={s.resTitle}>{coverageResults.rows.length} chi nhánh · {coverageResults.codes.length} mã</span>
                          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                            <button
                              onClick={() => exportToInvoice(coverageResults.items)}
                              style={{ background:C.accentBg, color:C.accent, border:`1px solid ${C.accentBorder}`, borderRadius:5, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap" }}>
                              📋 Tạo đơn báo giá
                            </button>
                            <span style={s.badge("accent")}>✅ {fullCoverageCount} đủ hàng</span>
                            <span style={s.badge("red")}>⚠ {coverageResults.rows.length-fullCoverageCount} thiếu</span>
                          </div>
                        </div>

                        {/* Code legend with qty+dvt */}
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
                          {coverageResults.items.map(it => (
                            <span key={it.maHang} style={{ ...s.badge("blue"), display:"flex", gap:4, alignItems:"center", padding:"3px 9px" }}>
                              <span style={{ fontWeight:700 }}>{it.maHang}</span>
                              {it.tenHang && <span style={{ color:C.dim, fontSize:10 }}>{it.tenHang.length>20?it.tenHang.slice(0,20)+"…":it.tenHang}</span>}
                              {(it.needQty!==''&&it.needQty!=null) && (
                                <span style={{ background:C.amberBg, color:C.amber, borderRadius:3, padding:"0 5px", fontSize:10 }}>
                                  ≥{fmtNum(Number(it.needQty))} {it.dvt}
                                </span>
                              )}
                            </span>
                          ))}
                        </div>

                        {coverageResults.rows.map((r,i) => (
                          <div key={i} style={s.coverageCard(r.hasAll)}>
                            <div style={{ fontSize:16 }}>{r.hasAll?"✅":"⚠"}</div>
                            <div style={{ flex:1 }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                                <span style={{ fontWeight:700, color:r.hasAll?C.accent:C.red, fontSize:12 }}>Chi nhánh {r.chiNhanh}</span>
                                <span style={{ fontSize:10, color:C.mutedLight }}>{r.tinhThanh}</span>
                              </div>
                              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                                {r.codeStatus.map(cs => (
                                  <span key={cs.code} style={{
                                    fontSize:10, padding:"2px 8px", borderRadius:4,
                                    background: cs.ok?C.accentBg:C.redBg,
                                    border:`1px solid ${cs.ok?C.accentBorder:C.redBorder}`,
                                    color: cs.ok?C.accent:C.red,
                                    display:"flex", alignItems:"center", gap:4,
                                  }}>
                                    <span>{cs.ok?"✓":"✗"} {cs.code}</span>
                                    <span style={{ opacity:0.8 }}>
                                      {fmtNum(cs.qty)}{cs.info?.dvt?" "+cs.info.dvt:""}
                                      {cs.needed>0&&<span style={{ opacity:0.6 }}>/{fmtNum(cs.needed)}</span>}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div style={{ textAlign:"right", flexShrink:0 }}>
                              <div style={{ fontSize:13, fontWeight:700, color:r.hasAll?C.accent:C.red }}>{r.count}/{r.codeStatus.length}</div>
                              <ProgressBar value={r.count} max={r.codeStatus.length} color={r.hasAll?C.accent:C.amber}/>
                            </div>
                          </div>
                        ))}
                        {coverageResults.rows.length===0 && <div style={s.empty}>Không có chi nhánh nào khớp điều kiện lọc</div>}
                      </>
                    )}

                    {!coverageResults && (
                      <div style={s.empty}>
                        <div style={s.emptyIcon}>🗺</div>
                        Thêm mã hàng — kết quả hiện ngay<br/>
                        <span style={{ fontSize:11, color:C.muted }}>Tìm chi nhánh tồn đủ tất cả mã theo số lượng yêu cầu</span>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <UploadPreviewModal preview={preview} prevMeta={meta} onCancel={()=>setPreview(null)} onConfirm={confirmUpload}/>
      )}

      {exportToast && (
        <div style={{ position:"fixed", bottom:20, right:20, background:C.accent, color:"#fff", borderRadius:6, padding:"10px 16px", fontSize:12, fontWeight:700, boxShadow:"0 4px 16px #00000030", zIndex:999, animation:"fadeIn .2s ease" }}>
          ✅ {exportToast}
        </div>
      )}

      {/* ── FOOTER ── */}
      <div style={{ background:C.headerBg, borderTop:"1px solid #16304f", padding:"8px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ fontSize:10, color:"#7a9bbf" }}>
          <span style={{ color:"#7ecfab", fontWeight:700 }}>ECM Team</span> · TrungSon Pharma
        </div>
        <div style={{ fontSize:10, color:"#7a9bbf", display:"flex", gap:16 }}>
          <span>Build: <span style={{ color:"#c8e8ff" }}>{BUILD_DATE}</span></span>
          <span>Version <span style={{ color:"#c8e8ff", fontWeight:700 }}>v{VERSION}</span></span>
          <span style={{ color:"#4a6a8a" }}>© 2026 TrungSon Pharma</span>
        </div>
      </div>
    </div>
  );
}
