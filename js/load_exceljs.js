// load_exceljs.js — loads the ExcelJS library only when someone actually exports.
//
// It used to be a <script> tag on Reports and the Audit Trail, so every visit
// downloaded ~900 KB that most visits never used. Now the export button calls
// loadExcelJS() and the file is fetched on the first export only (and kept for
// later ones). Returns the ExcelJS namespace; rejects if it can't be loaded, so
// callers can show their usual "export is not available" message.
//
// Keep the version pinned. If you change it, check the export code in
// admin_reports.js and super_admin_audit.js still works.
const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

let loadPromise = null;

export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = EXCELJS_URL;
    script.async = true;
    script.onload = () => {
      if (window.ExcelJS) resolve(window.ExcelJS);
      else reject(new Error('ExcelJS loaded but did not initialise.'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('ExcelJS could not be downloaded.'));
    };
    document.head.appendChild(script);
  }).catch((err) => {
    loadPromise = null; // allow a retry on the next export click
    throw err;
  });

  return loadPromise;
}
