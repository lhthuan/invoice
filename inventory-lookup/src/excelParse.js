/**
 * Module phân tích và kiểm tra dữ liệu file Excel tồn kho (thuần JS, không phụ thuộc bundler/React).
 * Nhận đối tượng workbook đã đọc bởi SheetJS và thư viện XLSX qua tham số.
 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;

/**
 * Chuẩn hoá tiêu đề cột: bỏ ký tự ẩn, bỏ dấu tiếng Việt (NFD + đ→d),
 * chuyển về chữ thường và gộp khoảng trắng / gạch dưới.
 * @param {unknown} s
 * @returns {string}
 */
export function normHeader(s) {
  if (s == null) return "";
  return String(s)
    .replace(ZERO_WIDTH_RE, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .trim();
}

/**
 * Làm sạch chuỗi văn bản trong ô dữ liệu: bỏ ký tự ẩn, chuẩn hoá NFC, gộp khoảng trắng.
 * @param {unknown} v
 * @returns {string}
 */
function cleanText(v) {
  if (v == null) return "";
  return String(v)
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\u00A0/g, " ")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chuyển giá trị ô số lượng thành number.
 * - number hữu hạn: giữ nguyên
 * - chuỗi: hỗ trợ số âm kế toán "(12)" và ERP "12-", định dạng VN "1.234,5" & "1.234",
 *   định dạng quốc tế "1,234.5" & "1,234", số thập phân "12,5" hoặc "12.5".
 * - trả về null nếu không parse được.
 * @param {unknown} v
 * @returns {number | null}
 */
export function parseQty(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Object.is(v, -0) ? 0 : v;
  }
  if (typeof v !== "string") return null;

  let s = v.replace(ZERO_WIDTH_RE, "").replace(/[\u00A0\s]+/g, "").trim();
  if (!s) return null;

  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  } else if (s.endsWith("-")) {
    neg = true;
    s = s.slice(0, -1);
  } else if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  if (!s) return null;

  let normalized = null;

  if (/^\d+$/.test(s)) {
    normalized = s;
  } else if (/^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(s)) {
    // Định dạng VN có dấu chấm phân cách hàng nghìn: "1.234", "1.234.567", "1.234,5"
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) {
    // Định dạng quốc tế có dấu phẩy phân cách hàng nghìn: "1,234.5", "1,234,567", "1,234"
    normalized = s.replace(/,/g, "");
  } else if (/^\d+,\d+$/.test(s)) {
    // Số thập phân dùng dấu phẩy không có dấu nghìn: "12,5", "0,25"
    normalized = s.replace(",", ".");
  } else if (/^\d+\.\d+$/.test(s)) {
    // Số thập phân dùng dấu chấm: "12.5", "0.125", "1234.5"
    normalized = s;
  } else {
    return null;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  return neg ? -n : n;
}

/**
 * Bảng quy tắc ánh xạ cột theo thứ tự ưu tiên trường và alias.
 * Mỗi trường gồm:
 * - primary: các alias đặc trưng cao
 * - fallback: các alias chung hơn (chỉ xét khi không khớp primary)
 * - exclude: các cụm từ loại trừ không được phép chọn
 */
const FIELD_RULES = [
  {
    field: "maHang",
    required: true,
    primary: [
      "ma hang",
      "mahang",
      "ma hang hoa",
      "ma vt",
      "ma vat tu",
      "mavt",
      "ma san pham",
      "ma sp",
      "masp",
      "item code",
      "itemcode",
      "product code",
      "sku",
      "ma hh",
    ],
    fallback: [],
    exclude: [
      "ma kho",
      "makho",
      "chi nhanh",
      "chinhanh",
      "nhom",
      "loai",
      "barcode",
      "ma vach",
    ],
  },
  {
    field: "cuoiKy",
    required: true,
    primary: [
      "ton cuoi ky",
      "sl cuoi ky",
      "so luong cuoi ky",
      "cuoi ky",
      "cuoiky",
      "ton cuoi",
      "sl ton cuoi",
      "so luong ton kho",
      "so luong ton",
      "sl ton",
      "ton kho",
      "tonkho",
      "closing stock",
      "closing balance",
      "closing qty",
      "ending inventory",
      "ending qty",
      "ending",
      "qty closing",
      "closing",
    ],
    fallback: ["quantity", "qty", "so luong", "ton"],
    exclude: [
      "ton dau ky",
      "dau ky",
      "ton dau",
      "beginning",
      "opening",
      "begin",
      "price",
      "value",
      "amount",
      "nhap",
      "xuat",
      "gia tri",
      "thanh tien",
      "don gia",
      "gia von",
      "dinh muc",
      "toi thieu",
      "toi da",
    ],
  },
  {
    field: "chiNhanh",
    required: true,
    primary: [
      "chi nhanh",
      "ten chi nhanh",
      "chinhanh",
      "tenchinhanh",
      "chi nhanh kho",
      "branch name",
      "branch",
    ],
    fallback: ["cua hang", "showroom", "diem ban"],
    exclude: ["ma hang", "ten hang"],
  },
  {
    field: "tenHang",
    required: false,
    primary: [
      "ten hang",
      "tenhang",
      "ten hang hoa",
      "ten vt",
      "ten vat tu",
      "ten san pham",
      "ten sp",
      "tensp",
      "product name",
      "item name",
      "ten hh",
    ],
    fallback: ["dien giai", "mo ta", "description"],
    exclude: ["chi nhanh", "chinhanh", "ten kho", "nhom", "loai"],
  },
  {
    field: "maKho",
    required: false,
    primary: [
      "ma kho",
      "makho",
      "ma kho hang",
      "warehouse code",
      "warehouse id",
      "warehouse",
    ],
    fallback: ["kho hang", "kho"],
    exclude: ["ton kho", "tonkho", "chi nhanh", "ma hang", "ten hang", "khoang"],
  },
  {
    field: "dvt",
    required: false,
    primary: ["dvt", "don vi tinh", "donvitinh", "d.v.t", "uom", "unit"],
    fallback: ["don vi"],
    exclude: ["kinh doanh", "don gia", "gia", "thanh tien", "chi nhanh"],
  },
  {
    field: "tinhThanh",
    required: false,
    primary: [
      "tinh thanh",
      "tinhthanh",
      "tinh thanh pho",
      "tinh tp",
      "tinh/tp",
      "tinh/thanh",
      "province",
      "city",
    ],
    fallback: ["tinh", "khu vuc"],
    exclude: [
      "don vi tinh",
      "dvt",
      "tinh trang",
      "tam tinh",
      "tinh chat",
      "may tinh",
      "tai chinh",
    ],
  },
];

/**
 * Tìm cột phù hợp nhất cho 1 danh sách alias theo thứ tự ưu tiên:
 * Khớp chính xác (exact) > Bắt đầu bằng (startsWith) > Chứa (includes).
 * @param {{ raw: string, norm: string, idx: number }[]} candidates
 * @param {string[]} aliases
 * @returns {{ col: { raw: string, norm: string, idx: number }, matchScore: number } | null}
 */
function findByPriority(candidates, aliases) {
  if (!aliases.length || !candidates.length) return null;

  // 1. Khớp chính xác (Exact match)
  for (const alias of aliases) {
    const hit = candidates.find((c) => c.norm === alias);
    if (hit) return { col: hit, matchScore: 15 };
  }

  // 2. Bắt đầu bằng (Starts-with match)
  for (const alias of aliases) {
    const hit = candidates.find((c) => c.norm.startsWith(alias));
    if (hit) return { col: hit, matchScore: 10 };
  }

  // 3. Chứa chuỗi con (Contains match)
  for (const alias of aliases) {
    const hit = candidates.find((c) => c.norm.includes(alias));
    if (hit) return { col: hit, matchScore: 5 };
  }

  return null;
}

/**
 * Ánh xạ 1 dòng tiêu đề sang các trường dữ liệu, đảm bảo mỗi cột chỉ dùng tối đa 1 lần.
 * @param {unknown[]} headerCells
 */
function mapHeaderRow(headerCells) {
  const cells = Array.isArray(headerCells) ? headerCells : [];
  const normCells = cells.map((c, idx) => ({
    raw: cleanText(c),
    norm: normHeader(c),
    idx,
  }));

  const usedIndices = new Set();
  const columns = {
    maHang: null,
    tenHang: null,
    chiNhanh: null,
    tinhThanh: null,
    maKho: null,
    dvt: null,
    cuoiKy: null,
  };
  const colIndex = {
    maHang: -1,
    tenHang: -1,
    chiNhanh: -1,
    tinhThanh: -1,
    maKho: -1,
    dvt: -1,
    cuoiKy: -1,
  };

  let score = 0;

  for (const rule of FIELD_RULES) {
    const eligible = normCells.filter(
      (c) =>
        !usedIndices.has(c.idx) &&
        c.norm.length > 0 &&
        !c.norm.startsWith("__empty") &&
        !rule.exclude.some((ex) => c.norm.includes(ex))
    );

    let matched = findByPriority(eligible, rule.primary);
    let isPrimary = true;
    if (!matched && rule.fallback.length > 0) {
      matched = findByPriority(eligible, rule.fallback);
      isPrimary = false;
    }

    if (matched) {
      const { col, matchScore } = matched;
      usedIndices.add(col.idx);
      columns[rule.field] = col.raw || String(cells[col.idx]);
      colIndex[rule.field] = col.idx;
      score += (rule.required ? 100 : 20) + matchScore + (isPrimary ? 5 : 0);
    }
  }

  return { columns, colIndex, score };
}

/**
 * Kiểm tra xem ô văn bản có phải từ khoá dòng tổng cộng / cộng nhóm hay không.
 * Hỗ trợ cả kiểm tra chính xác không dấu và kiểm tra có dấu để tránh bắt nhầm
 * tên hàng như "Công tắc", "Cổng USB", "Tổng đài", "Chi nhánh Cộng Hòa".
 * @param {string} rawText
 * @param {boolean} isCodeCell
 * @returns {boolean}
 */
function isTotalKeyword(rawText, isCodeCell = false) {
  if (!rawText) return false;
  const lower = rawText.toLowerCase().replace(/[:.,;-]+$/g, "").trim();
  const norm = normHeader(rawText).replace(/[:.,;-]+$/g, "").trim();
  if (!norm) return false;

  // Khớp chính xác trên mọi cột
  if (
    norm === "tong cong" ||
    norm === "cong" ||
    norm === "tong" ||
    norm === "total" ||
    norm === "grand total" ||
    norm === "sub total" ||
    norm === "subtotal" ||
    norm.startsWith("tong cong ") ||
    norm.startsWith("grand total ") ||
    norm.startsWith("sub total ") ||
    norm.startsWith("subtotal ") ||
    norm.startsWith("total ")
  ) {
    return true;
  }

  // Có dấu tiếng Việt: "cộng ...", "tổng cộng ..."
  if (
    lower.startsWith("tổng cộng") ||
    lower.startsWith("cộng ") ||
    lower === "cộng" ||
    lower === "tổng"
  ) {
    return true;
  }

  // Trên cột mã hàng hoặc khi dòng không có mã hàng: cho phép bắt "cong ...", "tong ..." không dấu
  if (isCodeCell && (norm.startsWith("cong ") || norm.startsWith("tong "))) {
    return true;
  }

  return false;
}

/**
 * Xây dựng hàm tra cứu tỉnh thành từ branchMap (hỗ trợ khớp chính xác và khớp chuẩn hoá).
 * @param {Record<string, string> | undefined | null} branchMap
 */
function createBranchLookup(branchMap) {
  const exactMap = new Map();
  const lowerMap = new Map();
  const normMap = new Map();

  if (branchMap && typeof branchMap === "object") {
    for (const [k, v] of Object.entries(branchMap)) {
      const cleanK = cleanText(k);
      const cleanV = cleanText(v);
      if (!cleanK || !cleanV) continue;
      exactMap.set(cleanK, cleanV);
      lowerMap.set(cleanK.toLowerCase(), cleanV);
      normMap.set(normHeader(cleanK), cleanV);
    }
  }

  return function lookupProvince(chiNhanh) {
    if (!chiNhanh) return "";
    return (
      exactMap.get(chiNhanh) ||
      lowerMap.get(chiNhanh.toLowerCase()) ||
      normMap.get(normHeader(chiNhanh)) ||
      ""
    );
  };
}

/**
 * Phân tích workbook Excel tồn kho:
 * - Quét tất cả các sheet và 20 dòng đầu mỗi sheet để chọn sheet + dòng tiêu đề có điểm cao nhất.
 * - Ánh xạ cột theo bảng alias có độ ưu tiên, không dùng trùng cột.
 * - Chuẩn hoá dữ liệu từng dòng, bỏ dòng tổng cộng/cộng, fill-down chiNhanh trống khi dòng có mã hàng.
 * - Tính toán thống kê, điều kiện chặn cứng (blockers) và cảnh báo (warnings) theo CONTRACT.
 *
 * @param {object} wb Workbook từ SheetJS
 * @param {object} XLSX Thư viện SheetJS (XLSX)
 * @param {{ branchMap?: Record<string, string>, previousMeta?: object | null }} [options]
 */
export function analyzeWorkbook(wb, XLSX, { branchMap = {}, previousMeta = null } = {}) {
  const emptyColumns = {
    maHang: null,
    tenHang: null,
    chiNhanh: null,
    tinhThanh: null,
    maKho: null,
    dvt: null,
    cuoiKy: null,
  };

  if (!wb || !Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0 || !XLSX?.utils?.sheet_to_json) {
    return {
      sheetName: "",
      headerRow: 0,
      columns: emptyColumns,
      rows: [],
      skipped: [],
      stats: { total: 0, valid: 0, skipped: 0, branches: 0, qtySum: 0 },
      blockers: [
        "Không tìm thấy sheet dữ liệu hợp lệ trong file Excel.",
        "Không xác định được cột Mã hàng (maHang), Tồn cuối kỳ (cuoiKy), Chi nhánh (chiNhanh).",
        "Số dòng hợp lệ quá ít: 0 dòng (yêu cầu tối thiểu 100 dòng hợp lệ).",
      ],
      warnings: [],
    };
  }

  let bestChoice = null;

  for (let sIdx = 0; sIdx < wb.SheetNames.length; sIdx++) {
    const sheetName = wb.SheetNames[sIdx];
    const ws = wb.Sheets?.[sheetName];
    if (!ws) continue;

    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true }) || [];
    const scanLimit = Math.min(20, aoa.length);

    let sheetBest = {
      sheetName,
      aoa,
      headerRow: 0,
      columns: { ...emptyColumns },
      colIndex: { maHang: -1, tenHang: -1, chiNhanh: -1, tinhThanh: -1, maKho: -1, dvt: -1, cuoiKy: -1 },
      score: -1,
    };

    for (let r = 0; r < scanLimit; r++) {
      const mapped = mapHeaderRow(aoa[r]);
      const hasDataBelow = aoa.length > r + 1 ? 1 : 0;
      const totalScore = mapped.score > 0 ? mapped.score + hasDataBelow : 0;

      if (totalScore > sheetBest.score) {
        sheetBest = {
          sheetName,
          aoa,
          headerRow: r,
          columns: mapped.columns,
          colIndex: mapped.colIndex,
          score: totalScore,
        };
      }
    }

    if (!bestChoice || sheetBest.score > bestChoice.score) {
      bestChoice = sheetBest;
    }
  }

  const { sheetName, aoa, headerRow, columns, colIndex } = bestChoice;
  const lookupProvince = createBranchLookup(branchMap);

  // aoa[r][c] ↔ ô (range.s.r + r, range.s.c + c) vì sheet_to_json(header:1) giữ cả dòng trống
  const ws = wb.Sheets[sheetName];
  const range = ws?.["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 } };
  const displayText = (r, c, fallback) => {
    const R = range.s.r + r, C = range.s.c + c;
    const cell = ws?.["!data"] ? ws["!data"][R]?.[C] : ws?.[XLSX.utils.encode_cell({ r: R, c: C })];
    return cell && cell.t === "n" && cell.w != null ? cell.w : fallback;
  };

  const rows = [];
  const skipped = [];
  let errorRowsCount = 0;
  const errorRowSamples = [];
  let missingBranchCount = 0;
  const missingBranchSamples = [];

  const hasMaHangCol = colIndex.maHang >= 0;
  const hasCuoiKyCol = colIndex.cuoiKy >= 0;

  let lastChiNhanh = "";

  if (hasMaHangCol || hasCuoiKyCol) {
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const rowCells = aoa[r];
      if (!Array.isArray(rowCells)) continue;

      // Bỏ qua dòng trống hoàn toàn
      let isAllBlank = true;
      for (let c = 0; c < rowCells.length; c++) {
        if (cleanText(rowCells[c]) !== "") {
          isAllBlank = false;
          break;
        }
      }
      // Dòng trống không ngắt fill-down: ô gộp chi nhánh có thể kẹp dòng trống ở giữa
      if (isAllBlank) continue;

      // Mã hàng lấy theo text hiển thị (cell.w) để giữ số 0 đầu khi Excel lưu dạng số (00123)
      const rawMaHang = hasMaHangCol ? cleanText(displayText(r, colIndex.maHang, rowCells[colIndex.maHang])) : "";
      const rawTenHang = colIndex.tenHang >= 0 ? cleanText(rowCells[colIndex.tenHang]) : "";
      const rawChiNhanh = colIndex.chiNhanh >= 0 ? cleanText(rowCells[colIndex.chiNhanh]) : "";
      const rawTinhThanh = colIndex.tinhThanh >= 0 ? cleanText(rowCells[colIndex.tinhThanh]) : "";
      const rawMaKho = colIndex.maKho >= 0 ? cleanText(rowCells[colIndex.maKho]) : "";
      const rawDvt = colIndex.dvt >= 0 ? cleanText(rowCells[colIndex.dvt]) : "";
      const rawCuoiKy = hasCuoiKyCol ? rowCells[colIndex.cuoiKy] : undefined;

      // Kiểm tra dòng tổng cộng / cộng nhóm
      const firstNonEmpty = cleanText(rowCells.find((cell) => cleanText(cell) !== ""));
      // Dòng có mã hàng chỉ bị coi là dòng tổng khi chính ô mã hàng là từ khoá tổng —
      // tên hàng "Total Care…" hay chi nhánh "Cộng Hòa" không được làm mất dòng
      const isTotalRow = rawMaHang
        ? isTotalKeyword(rawMaHang, true)
        : isTotalKeyword(rawTenHang, true) || isTotalKeyword(rawChiNhanh, true) || isTotalKeyword(firstNonEmpty, true);

      if (isTotalRow) {
        lastChiNhanh = "";
        skipped.push({ rowIndex: r, reason: "Dòng tổng cộng / cộng nhóm" });
        continue;
      }

      const maHang = rawMaHang.toUpperCase();
      if (!maHang || /^-+$/.test(maHang)) {
        skipped.push({ rowIndex: r, reason: "Thiếu mã hàng (maHang)" });
        errorRowsCount++;
        if (errorRowSamples.length < 5) errorRowSamples.push(r + 1);
        continue;
      }

      // "-" là cách Excel kế toán hiển thị số 0
      const cuoiKy = /^\s*-+\s*$/.test(String(rawCuoiKy ?? "")) ? 0 : parseQty(rawCuoiKy);
      if (cuoiKy === null) {
        skipped.push({
          rowIndex: r,
          reason: `Số lượng cuối kỳ (cuoiKy) không hợp lệ: "${cleanText(rawCuoiKy)}"`,
        });
        errorRowsCount++;
        if (errorRowSamples.length < 5) errorRowSamples.push(r + 1);
        continue;
      }

      // Fill-down chiNhanh trống khi dòng có mã hàng (xử lý ô gộp)
      let chiNhanh = rawChiNhanh;
      if (chiNhanh) {
        lastChiNhanh = chiNhanh;
      } else if (lastChiNhanh) {
        chiNhanh = lastChiNhanh;
      }

      if (!chiNhanh) {
        missingBranchCount++;
        if (missingBranchSamples.length < 5) missingBranchSamples.push(r + 1);
      }

      const tinhThanh = rawTinhThanh || lookupProvince(chiNhanh) || "";

      rows.push({
        maHang,
        tenHang: rawTenHang,
        chiNhanh,
        tinhThanh,
        maKho: rawMaKho,
        dvt: rawDvt,
        cuoiKy,
      });
    }
  }

  const branchSet = new Set();
  let rawQtySum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.chiNhanh) branchSet.add(row.chiNhanh);
    rawQtySum += row.cuoiKy;
  }
  const qtySum = Math.round(rawQtySum * 1e6) / 1e6;

  const stats = {
    total: rows.length + skipped.length,
    valid: rows.length,
    skipped: skipped.length,
    branches: branchSet.size,
    qtySum,
  };

  // ─── BLOCKERS (Chặn cứng theo CONTRACT) ────────────────────────────────────
  const blockers = [];

  if (!columns.maHang) {
    blockers.push(
      `Không xác định được cột Mã hàng (maHang) tại dòng tiêu đề (dòng ${headerRow + 1}).`
    );
  }
  if (!columns.cuoiKy) {
    blockers.push(
      `Không xác định được cột Tồn cuối kỳ (cuoiKy) tại dòng tiêu đề (dòng ${headerRow + 1}).`
    );
  }
  if (!columns.chiNhanh) {
    blockers.push(
      `Không xác định được cột Chi nhánh (chiNhanh) tại dòng tiêu đề (dòng ${headerRow + 1}).`
    );
  }

  if (stats.valid < 100) {
    blockers.push(
      `Số dòng hợp lệ quá ít: ${stats.valid} dòng (yêu cầu tối thiểu 100 dòng hợp lệ).`
    );
  }

  const candidateDataRows = stats.valid + errorRowsCount;
  if (candidateDataRows > 0) {
    const errorRate = errorRowsCount / candidateDataRows;
    if (errorRate > 0.02) {
      blockers.push(
        `Tỷ lệ dòng lỗi vượt ngưỡng 2%: ${errorRowsCount}/${candidateDataRows} dòng (${(
          errorRate * 100
        ).toFixed(1)}%), tại các dòng ${errorRowSamples.join(", ")}.`
      );
    }
  }

  if (stats.valid > 0) {
    const missingBranchRate = missingBranchCount / stats.valid;
    if (missingBranchRate > 0.01) {
      blockers.push(
        `Tỷ lệ dòng thiếu Chi nhánh (chiNhanh) vượt ngưỡng 1%: ${missingBranchCount}/${
          stats.valid
        } dòng (${(missingBranchRate * 100).toFixed(
          1
        )}%), tại các dòng ${missingBranchSamples.join(", ")}.`
      );
    }
  }

  // ─── WARNINGS (Cảnh báo cần xác nhận theo CONTRACT) ────────────────────────
  const warnings = [];

  if (previousMeta && typeof previousMeta === "object") {
    const prevRows = Number(
      previousMeta.row_count ?? previousMeta.rowCount ?? previousMeta.valid ?? 0
    );
    const prevBranches = Number(
      previousMeta.branches ?? previousMeta.branch_count ?? previousMeta.branchCount ?? 0
    );
    const prevQtySum = Number(previousMeta.qty_sum ?? previousMeta.qtySum ?? NaN);

    if (Number.isFinite(prevRows) && prevRows > 0) {
      const rowDropRatio = (prevRows - stats.valid) / prevRows;
      if (rowDropRatio > 0.3) {
        warnings.push(
          `Số dòng hợp lệ giảm ${(rowDropRatio * 100).toFixed(
            1
          )}% (> 30%) so với bản trước: từ ${prevRows} xuống còn ${stats.valid} dòng.`
        );
      }
    }

    if (Number.isFinite(prevBranches) && prevBranches > 0) {
      const branchDropRatio = (prevBranches - stats.branches) / prevBranches;
      if (branchDropRatio > 0.2) {
        warnings.push(
          `Số lượng chi nhánh giảm ${(branchDropRatio * 100).toFixed(
            1
          )}% (> 20%) so với bản trước: từ ${prevBranches} xuống còn ${stats.branches} chi nhánh.`
        );
      }
    }

    if (Number.isFinite(prevQtySum) && prevQtySum !== 0) {
      const qtyDiffRatio = Math.abs(stats.qtySum - prevQtySum) / Math.abs(prevQtySum);
      if (qtyDiffRatio > 0.5) {
        warnings.push(
          `Tổng tồn cuối kỳ (cuoiKy) lệch ${(qtyDiffRatio * 100).toFixed(
            1
          )}% (> 50%) so với bản trước: từ ${prevQtySum} thành ${stats.qtySum}.`
        );
      }
    }
  }

  return {
    sheetName,
    headerRow,
    columns,
    rows,
    skipped,
    stats,
    blockers,
    warnings,
  };
}
