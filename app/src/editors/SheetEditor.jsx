import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createUniver } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import '@univerjs/preset-sheets-core/lib/index.css';
import './editor.css';

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toColor(value) {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color) || /^rgba?\([\d\s.,%]+\)$/i.test(color)) return { rgb: color };
  return undefined;
}

function normalizeStyle(style) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return style;
  const normalized = { ...style };
  if (normalized.bl === undefined && typeof normalized.bold === 'boolean') normalized.bl = Number(normalized.bold);
  if (normalized.it === undefined && typeof normalized.italic === 'boolean') normalized.it = Number(normalized.italic);
  if (normalized.ul === undefined && typeof normalized.underline === 'boolean') normalized.ul = { s: Number(normalized.underline) };
  if (normalized.st === undefined && typeof normalized.strikethrough === 'boolean') normalized.st = { s: Number(normalized.strikethrough) };
  if (normalized.fs === undefined && typeof normalized.fontSize === 'number' && Number.isFinite(normalized.fontSize)) normalized.fs = normalized.fontSize;
  if (normalized.ff === undefined && typeof normalized.fontFamily === 'string') normalized.ff = normalized.fontFamily;
  if (normalized.cl === undefined) normalized.cl = toColor(normalized.color);
  if (normalized.bg === undefined) normalized.bg = toColor(normalized.backgroundColor);
  if (normalized.ht === undefined && ['left', 'center', 'right'].includes(normalized.horizontalAlign)) normalized.ht = normalized.horizontalAlign;
  if (normalized.vt === undefined && ['top', 'middle', 'bottom'].includes(normalized.verticalAlign)) normalized.vt = normalized.verticalAlign;
  if (normalized.tb === undefined && typeof normalized.wrapStrategy === 'string') normalized.tb = normalized.wrapStrategy;
  if (normalized.n === undefined && typeof normalized.numberFormat === 'string') normalized.n = { pattern: normalized.numberFormat };
  for (const alias of ['bold', 'italic', 'underline', 'strikethrough', 'fontSize', 'fontFamily', 'color', 'backgroundColor', 'horizontalAlign', 'verticalAlign', 'wrapStrategy', 'numberFormat']) delete normalized[alias];
  if (normalized.cl === undefined) delete normalized.cl;
  if (normalized.bg === undefined) delete normalized.bg;
  return normalized;
}

function normalizeCellStyle(cell) {
  if (!cell || typeof cell !== 'object') return cell;
  if (cell.s && typeof cell.s === 'object') return { ...cell, s: normalizeStyle(cell.s) };
  return cell;
}

function normalizeWorkbook(input) {
  const workbook = copyJson(input);
  if (!workbook || typeof workbook !== 'object' || !workbook.sheets || typeof workbook.sheets !== 'object') {
    throw new Error('电子表格数据格式无效。');
  }
  workbook.styles = Object.fromEntries(Object.entries(workbook.styles ?? {}).map(([id, style]) => [id, normalizeStyle(style)]));
  for (const sheet of Object.values(workbook.sheets)) {
    if (!sheet || typeof sheet !== 'object') continue;
    const nextCellData = {};
    for (const [row, cells] of Object.entries(sheet.cellData ?? {})) {
      nextCellData[row] = Object.fromEntries(Object.entries(cells ?? {}).map(([column, cell]) => [column, normalizeCellStyle(cell)]));
    }
    sheet.cellData = nextCellData;
  }
  return workbook;
}

const SheetEditor = forwardRef(function SheetEditor({ value, onChange }, ref) {
  const hostRef = useRef(null);
  const runtimeRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [error, setError] = useState('');
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let active = true;
    let pendingTimer = 0;
    let lastSnapshot = '';
    let workbook;
    let workbookListener;
    let univer;
    let univerAPI;

    try {
      const initialData = normalizeWorkbook(value);
      const created = createUniver({
        locale: 'zhCN',
        region: 'zhCN',
        locales: { zhCN },
        presets: [UniverSheetsCorePreset({
          container: host,
          header: true,
          toolbar: true,
          formulaBar: true,
          footer: { sheetBar: true, statisticBar: true, menus: true, zoomSlider: true },
          contextMenu: true,
          disableAutoFocus: true,
        })],
      });
      univer = created.univer;
      univerAPI = created.univerAPI;
      workbook = univerAPI.createWorkbook(initialData);
      lastSnapshot = JSON.stringify(workbook.save());
      runtimeRef.current = { univer, univerAPI, workbook, isActive: () => active };
      const publishChangedSnapshot = () => {
        if (!active || pendingTimer) return;
        pendingTimer = window.setTimeout(() => {
          pendingTimer = 0;
          if (!active) return;
          try {
            const snapshot = workbook.save();
            const serialized = JSON.stringify(snapshot);
            if (serialized === lastSnapshot) return;
            lastSnapshot = serialized;
            onChangeRef.current?.(copyJson(snapshot));
          } catch (snapshotError) {
            setError(snapshotError instanceof Error ? snapshotError.message : '读取表格内容失败。');
          }
        }, 120);
      };
      workbookListener = workbook.onCommandExecuted(publishChangedSnapshot);
      setError('');
    } catch (initError) {
      setError(initError instanceof Error ? initError.message : '电子表格编辑器启动失败。');
    }

    return () => {
      active = false;
      if (pendingTimer) window.clearTimeout(pendingTimer);
      workbookListener?.dispose();
      runtimeRef.current = null;
      univer?.dispose();
    };
  // Parent remounts by document.id when switching documents. Updating value while the
  // component stays mounted is a persistence echo and must not recreate the workbook.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    async flush() {
      const runtime = runtimeRef.current;
      if (!runtime || !runtime.isActive()) return value;
      const currentWorkbook = runtime.univerAPI.getWorkbook(runtime.workbook.getId()) ?? runtime.workbook;
      await currentWorkbook.endEditingAsync(true);
      const snapshot = currentWorkbook.save();
      return copyJson(snapshot);
    },
    focus() {
      hostRef.current?.querySelector('[tabindex="0"]')?.focus();
    },
  }), [value]);

  return (
    <section className="univer-sheet-editor" aria-label="电子表格编辑器">
      {error && <div className="editor-inline-message univer-sheet-message" role="alert">
        <span>表格暂时无法显示：{error}</span>
      </div>}
      <div ref={hostRef} className="univer-sheet-host" aria-label="电子表格网格" />
    </section>
  );
});

export default SheetEditor;
