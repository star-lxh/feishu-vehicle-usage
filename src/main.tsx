import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { bitable, FieldType, FilterConjunction, FilterOperator, ViewType, type FilterInfoCondition, type IFieldMeta, type IGridView, type ITableMeta } from "@lark-base-open/js-sdk";
import { addDays, endOfDay, endOfMonth, endOfWeek, format, isAfter, isBefore, isValid, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "./style.css";

type Period = "day" | "week" | "month";
type Unit = "hour" | "minute" | "second";
type Datum = { date: Date; hours: number; vehicle: string; recordId: string };
type FormulaVars = { ACC_SUM: number; ACC_AVG: number; RECORDS: number; WORKDAYS: number; AVAILABLE_HOURS: number };
type VehicleStat = { vehicle: string; hours: number; records: number; workdays: number; rate: number };
type TrendValue = { hours: number; records: number; rate: number };
type Trend = { key: string; label: string; workdays: number; values: Record<string, TrendValue>; [seriesKey: string]: string | number | Record<string, TrendValue> };

const DEFAULT_FORMULA = "ACC_SUM / AVAILABLE_HOURS";
const DETAIL_VIEW_NAME = "车辆使用率｜数据明细";
const COLORS = ["#3370ff", "#00a870", "#f5a623", "#7b61ff", "#e24a68", "#00a6a6", "#8b6f47", "#596780"];

const now = new Date();
const previousWeekAnchor = addDays(now, -7);
const inputDate = (d: Date) => format(d, "yyyy-MM-dd");
const isWorkday = (d: Date) => d.getDay() >= 1 && d.getDay() <= 5;
function countWorkdays(from: Date, to: Date) {
  let n = 0;
  for (let d = new Date(from); !isAfter(d, to); d = addDays(d, 1)) if (isWorkday(d)) n++;
  return n;
}
function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replace(/[^\d.-]/g, "")) || 0;
  if (Array.isArray(value)) return numeric(value[0]);
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return numeric(v.value ?? v.text ?? v.number ?? 0);
  }
  return 0;
}
function textValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    return textValue(v.text ?? v.name ?? v.value ?? v.id ?? "");
  }
  return "";
}
function dateValue(value: unknown): Date | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "number") {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return isValid(d) ? d : null;
  }
  if (typeof raw === "string") {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseISO(raw) : new Date(raw);
    return isValid(d) ? d : null;
  }
  if (raw && typeof raw === "object") {
    const v = raw as Record<string, unknown>;
    return dateValue(v.value ?? v.text);
  }
  return null;
}
const asHours = (v: number, u: Unit) => u === "minute" ? v / 60 : u === "second" ? v / 3600 : v;
function formulaVars(rows: Datum[], workdays: number): FormulaVars {
  const sum = rows.reduce((total, row) => total + row.hours, 0);
  return {
    ACC_SUM: sum,
    ACC_AVG: rows.length ? sum / rows.length : 0,
    RECORDS: rows.length,
    WORKDAYS: workdays,
    AVAILABLE_HOURS: workdays * 24,
  };
}
function evaluateFormula(expression: string, vars: FormulaVars): number {
  const source = expression.trim().toUpperCase();
  if (!source) throw new Error("公式不能为空");
  if (!/^[0-9A-Z_+\-*/().\s]+$/.test(source)) throw new Error("仅支持变量、数字、括号和 + - * /");
  const names = Object.keys(vars) as Array<keyof FormulaVars>;
  const words = source.match(/[A-Z_]+/g) ?? [];
  const unknown = words.find(word => !names.includes(word as keyof FormulaVars));
  if (unknown) throw new Error(`未知变量：${unknown}`);
  const calculate = Function(...names, `"use strict"; return (${source});`) as (...args: number[]) => number;
  const result = calculate(...names.map(name => vars[name]));
  return Number.isFinite(result) ? result : 0;
}
const groupKey = (d: Date, p: Period) => p === "day" ? format(d, "yyyy-MM-dd") : p === "week" ? format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd") : format(d, "yyyy-MM");
function groupLabel(d: Date, p: Period) {
  if (p === "day") return format(d, "M.d");
  return p === "month" ? format(d, "M月") : `${format(startOfWeek(d, { weekStartsOn: 1 }), "M.d")}–${format(endOfWeek(d, { weekStartsOn: 1 }), "M.d")}`;
}
function App() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [tables, setTables] = useState<ITableMeta[]>([]);
  const [tableId, setTableId] = useState("");
  const [tableName, setTableName] = useState("当前数据表");
  const [fields, setFields] = useState<IFieldMeta[]>([]);
  const [vehicleField, setVehicleField] = useState("");
  const [dateField, setDateField] = useState("");
  const [durationField, setDurationField] = useState("");
  const [unit, setUnit] = useState<Unit>("hour");
  const [formula, setFormula] = useState(DEFAULT_FORMULA);
  const [from, setFrom] = useState(inputDate(startOfWeek(previousWeekAnchor, { weekStartsOn: 1 })));
  const [to, setTo] = useState(inputDate(endOfWeek(previousWeekAnchor, { weekStartsOn: 1 })));
  const [period, setPeriod] = useState<Period>("day");
  const [rows, setRows] = useState<Datum[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hiddenVehicles, setHiddenVehicles] = useState<Set<string>>(() => new Set());

  const loadSourceTable = useCallback(async (id: string, tableMetas: ITableMeta[]) => {
    const table = await bitable.base.getTableById(id);
    const metas = await table.getFieldMetaList();
    setTableId(id);
    setTableName(tableMetas.find(item => item.id === id)?.name ?? await table.getName());
    setFields(metas);
    setRows([]);
    setHiddenVehicles(new Set());
    const d = metas.find(f => f.name.trim() === "日期") ?? metas.find(f => /日期|时间|date/i.test(f.name)) ?? metas.find(f => [FieldType.DateTime, FieldType.CreatedTime].includes(f.type));
    const h = metas.find(f => /ACC.*点火|点火.*时长|实际.*时长/i.test(f.name)) ?? metas.find(f => /时长|duration/i.test(f.name));
    const v = metas.find(f => /车辆名称|车辆名|车牌号|车牌|车辆|vehicle/i.test(f.name));
    setVehicleField(v?.id ?? "");
    setDateField(d?.id ?? "");
    setDurationField(h?.id ?? "");
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const tableMetas = await bitable.base.getTableMetaList();
      if (!tableMetas.length) throw new Error("当前多维表格没有数据表");
      let selectedId = tableMetas[0].id;
      try {
        const selection = await bitable.base.getSelection();
        if (selection.tableId && tableMetas.some(item => item.id === selection.tableId)) selectedId = selection.tableId;
      } catch {
        // 仪表盘页面没有当前数据表，使用第一张数据表作为默认值。
      }
      setTables(tableMetas);
      await loadSourceTable(selectedId, tableMetas);
      setConnected(true);
      setMessage("");
    } catch (error) {
      console.error("连接飞书多维表格失败", error);
      setConnected(false);
    } finally {
      setConnecting(false);
    }
  }, [loadSourceTable]);
  useEffect(() => { connect(); }, [connect]);

  async function changeSourceTable(id: string) {
    setBusy(true); setMessage("");
    try {
      await loadSourceTable(id, tables);
      setMessage("已切换数据源表，请确认字段后读取数据");
    } catch (error) {
      console.error("切换数据源表失败", error);
      setMessage("切换数据源表失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  async function readTable() {
    if (!dateField || !durationField) return setMessage("请先选择日期字段和 ACC 点火时长字段");
    setBusy(true); setMessage("");
    try {
      const table = await bitable.base.getTableById(tableId);
      let pageToken: number | undefined;
      const list: Datum[] = [];
      do {
        const page = await table.getRecordsByPage({ pageSize: 200, pageToken });
        for (const record of page.records) {
          const date = dateValue(record.fields[dateField]);
          if (date && isWorkday(date)) {
            const vehicle = vehicleField ? textValue(record.fields[vehicleField]) || "未填写车辆" : "全部车辆";
            list.push({ date, hours: asHours(numeric(record.fields[durationField]), unit), vehicle, recordId: record.recordId });
          }
        }
        pageToken = page.hasMore ? page.pageToken : undefined;
      } while (pageToken !== undefined);
      setRows(list);
      setPeriod("day");
      setMessage(`已读取 ${list.length} 条工作日记录`);
    } catch { setMessage("读取失败，请确认插件拥有当前多维表格的读取权限"); }
    finally { setBusy(false); }
  }

  const selected = useMemo(() => {
    const a = parseISO(from), b = endOfDay(parseISO(to));
    return rows.filter(r => !isBefore(r.date, a) && !isAfter(r.date, b));
  }, [rows, from, to]);
  const days = useMemo(() => countWorkdays(parseISO(from), parseISO(to)), [from, to]);
  const vehicles = useMemo<string[]>(() => Array.from(new Set<string>(selected.map(row => row.vehicle))).sort((a, b) => a.localeCompare(b, "zh-CN")), [selected]);
  const formulaError = useMemo(() => {
    try {
      evaluateFormula(formula, { ACC_SUM: 12, ACC_AVG: 3, RECORDS: 4, WORKDAYS: 5, AVAILABLE_HOURS: 120 });
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "公式格式错误";
    }
  }, [formula]);
  const vehicleStats = useMemo<VehicleStat[]>(() => vehicles.map(vehicle => {
    const list = selected.filter(row => row.vehicle === vehicle);
    const vars = formulaVars(list, days);
    return {
      vehicle,
      hours: vars.ACC_SUM,
      records: vars.RECORDS,
      workdays: days,
      rate: formulaError ? 0 : evaluateFormula(formula, vars),
    };
  }), [vehicles, selected, days, formula, formulaError]);
  const rankedVehicleStats = useMemo(() => [...vehicleStats].sort((a, b) => b.rate - a.rate), [vehicleStats]);
  const vehicleAxisWidth = useMemo(() => {
    const longest = rankedVehicleStats.reduce((length, item) => Math.max(length, Array.from(item.vehicle).length), 0);
    return Math.min(240, Math.max(96, longest * 14 + 24));
  }, [rankedVehicleStats]);
  const total = useMemo(() => selected.reduce((sum, row) => sum + row.hours, 0), [selected]);
  const rate = vehicleStats.length ? vehicleStats.reduce((sum, item) => sum + item.rate, 0) / vehicleStats.length : 0;
  const vehicleSeries = useMemo(() => vehicles.map((vehicle, index) => ({ vehicle, key: `vehicle_${index}`, color: COLORS[index % COLORS.length] })), [vehicles]);
  const visibleVehicleSeries = useMemo(() => vehicleSeries.filter(series => !hiddenVehicles.has(series.vehicle)), [vehicleSeries, hiddenVehicles]);
  const trend = useMemo<Trend[]>(() => {
    const keys = new Set<string>(selected.map(row => groupKey(row.date, period)));
    const a = parseISO(from), b = parseISO(to);
    for (let d = a; !isAfter(d, b); d = period === "day" ? addDays(d, 1) : period === "week" ? addDays(startOfWeek(d, { weekStartsOn: 1 }), 7) : addDays(endOfMonth(d), 1)) {
      if (period !== "day" || isWorkday(d)) keys.add(groupKey(d, period));
    }
    return [...keys].sort().map(key => {
      const anchor = period === "month" ? parseISO(`${key}-01`) : parseISO(key);
      const ps = period === "day" ? anchor : period === "week" ? startOfWeek(anchor, { weekStartsOn: 1 }) : startOfMonth(anchor);
      const pe = period === "day" ? anchor : period === "week" ? endOfWeek(anchor, { weekStartsOn: 1 }) : endOfMonth(anchor);
      const x = isBefore(ps, a) ? a : ps, y = isAfter(pe, b) ? b : pe;
      const workdays = countWorkdays(x, y);
      const point: Trend = { key, label: groupLabel(anchor, period), workdays, values: {} };
      for (const series of vehicleSeries) {
        const list = selected.filter(row => row.vehicle === series.vehicle && groupKey(row.date, period) === key);
        const vars = formulaVars(list, workdays);
        const item = { hours: vars.ACC_SUM, records: vars.RECORDS, rate: formulaError ? 0 : evaluateFormula(formula, vars) };
        point[series.key] = item.rate;
        point.values[series.vehicle] = item;
      }
      return point;
    });
  }, [selected, from, to, period, vehicleSeries, formula, formulaError]);

  function quick(p: "lastWeek" | "week" | "month") {
    if (p === "lastWeek") {
      const anchor = addDays(now, -7);
      setFrom(inputDate(startOfWeek(anchor, { weekStartsOn: 1 })));
      setTo(inputDate(endOfWeek(anchor, { weekStartsOn: 1 })));
      return;
    }
    setFrom(inputDate(p === "week" ? startOfWeek(now, { weekStartsOn: 1 }) : startOfMonth(now)));
    setTo(inputDate(now));
  }
  function toggleVehicle(vehicle: string) {
    setHiddenVehicles(current => {
      const next = new Set(current);
      if (next.has(vehicle)) next.delete(vehicle); else next.add(vehicle);
      return next;
    });
  }
  async function openVehicleDetail(entry: unknown) {
    const item = entry as VehicleStat & { payload?: VehicleStat };
    const vehicle = item.payload?.vehicle ?? item.vehicle;
    if (!vehicle || !tableId || !dateField) return;
    setBusy(true);
    setMessage(`正在打开 ${vehicle} 的原表记录…`);
    try {
      const table = await bitable.base.getTableById(tableId);
      const viewMetas = await table.getViewMetaList();
      let detailViewId = viewMetas.find(view => view.name === DETAIL_VIEW_NAME && view.type === ViewType.Grid)?.id;
      if (!detailViewId) detailViewId = (await table.addView({ name: DETAIL_VIEW_NAME, type: ViewType.Grid })).viewId;

      const view = await table.getViewById(detailViewId) as IGridView;
      const currentFilter = await view.getFilterInfo();
      for (const condition of currentFilter?.conditions ?? []) {
        if (condition.conditionId) await view.deleteFilterCondition(condition.conditionId);
      }
      await view.setFilterConjunction(FilterConjunction.And);

      const dateMeta = fields.find(field => field.id === dateField);
      if (!dateMeta || ![FieldType.DateTime, FieldType.CreatedTime, FieldType.ModifiedTime, FieldType.Formula, FieldType.Lookup].includes(dateMeta.type)) {
        throw new Error("当前日期字段不支持原表范围筛选，请在字段设置中选择日期类型字段");
      }
      const startBoundary = parseISO(from).getTime() - 1;
      const endBoundary = addDays(parseISO(to), 1).getTime();
      const conditions: FilterInfoCondition[] = [
        { fieldId: dateField, fieldType: dateMeta.type, operator: FilterOperator.IsGreater, value: startBoundary } as FilterInfoCondition,
        { fieldId: dateField, fieldType: dateMeta.type, operator: FilterOperator.IsLess, value: endBoundary } as FilterInfoCondition,
      ];

      if (vehicleField) {
        const vehicleMeta = fields.find(field => field.id === vehicleField);
        if (!vehicleMeta) throw new Error("找不到车辆名称字段");
        if (vehicle === "未填写车辆") {
          conditions.push({ fieldId: vehicleField, fieldType: vehicleMeta.type, operator: FilterOperator.IsEmpty, value: null } as FilterInfoCondition);
        } else if (vehicleMeta.type === FieldType.SingleSelect || vehicleMeta.type === FieldType.MultiSelect) {
          const options = (vehicleMeta.property as { options?: Array<{ id: string; name: string }> }).options ?? [];
          const option = options.find(candidate => candidate.name === vehicle);
          if (!option) throw new Error(`找不到车辆选项：${vehicle}`);
          conditions.push({
            fieldId: vehicleField,
            fieldType: vehicleMeta.type,
            operator: vehicleMeta.type === FieldType.SingleSelect ? FilterOperator.Is : FilterOperator.Contains,
            value: option.id,
          } as FilterInfoCondition);
        } else if ([FieldType.Text, FieldType.Phone, FieldType.Url, FieldType.Email, FieldType.Barcode, FieldType.Formula, FieldType.Lookup].includes(vehicleMeta.type)) {
          conditions.push({ fieldId: vehicleField, fieldType: vehicleMeta.type, operator: FilterOperator.Is, value: vehicle } as FilterInfoCondition);
        } else {
          throw new Error("当前车辆字段类型暂不支持原表筛选，请使用文本或单选字段");
        }
      }

      await view.addFilterCondition(conditions);
      setMessage(`已在原数据表中打开：${vehicle} · ${from} 至 ${to}`);
      await bitable.ui.switchToView(tableId, detailViewId);
    } catch (error) {
      console.error("打开原表筛选视图失败", error);
      setMessage(error instanceof Error ? error.message : "暂时无法打开原表记录，请确认你拥有数据表编辑权限");
    } finally {
      setBusy(false);
    }
  }
  async function writeBack() {
    if (!rows.length) return setMessage("请先读取当前表格");
    setBusy(true); setMessage("");
    try {
      const periodName = period === "day" ? "统计日" : period === "week" ? "统计周" : "统计月";
      const { tableId } = await bitable.base.addTable({ name: `使用率统计_${format(new Date(), "MMdd_HHmm")}`, fields: [{ type: FieldType.Text, name: periodName }] });
      const table = await bitable.base.getTable(tableId);
      const existing = await table.getFieldMetaList();
      const primary = existing.find(f => f.isPrimary) ?? existing[0];
      await table.setField(primary.id, { name: periodName });
      const v = await table.addField({ type: FieldType.Text, name: "车辆名称" });
      const h = await table.addField({ type: FieldType.Number, name: "实际使用时长(h)" });
      const c = await table.addField({ type: FieldType.Number, name: "记录数" });
      const d = await table.addField({ type: FieldType.Number, name: "工作日数" });
      const a = await table.addField({ type: FieldType.Number, name: "可用时长(h)" });
      const r = await table.addField({ type: FieldType.Number, name: "车辆使用率" });
      const f = await table.addField({ type: FieldType.Text, name: "计算公式" });
      const records = trend.flatMap(point => vehicleSeries.map(series => {
        const value = point.values[series.vehicle] ?? { hours: 0, records: 0, rate: 0 };
        return { fields: { [primary.id]: point.label, [v]: series.vehicle, [h]: +value.hours.toFixed(2), [c]: value.records, [d]: point.workdays, [a]: point.workdays * 24, [r]: +value.rate.toFixed(6), [f]: formula } };
      }));
      await table.addRecords(records);
      setMessage(`已按“周期 × 车辆”回写 ${records.length} 条统计结果`);
    } catch { setMessage("回写失败，请确认你拥有编辑权限"); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div className="logo">▥</div><div><b>车辆使用率统计</b><small>工作日 × 24 小时口径</small></div><button className={`status ${connected ? "ok" : "warn"}`} onClick={connected || connecting ? undefined : connect}>{connected ? `已连接 · ${tableName}` : connecting ? "正在连接飞书…" : "连接失败 · 点此重试"}</button></header>
    <div className={`layout ${settingsOpen ? "" : "settings-collapsed"}`}>
      <aside className={`panel settings-panel ${settingsOpen ? "open" : "collapsed"}`}>
        <button type="button" className="settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}><span><b>字段设置</b><small>{settingsOpen ? "完成后可点击收起" : "已自动匹配，点击展开修改"}</small></span><i>{settingsOpen ? "⌃" : "⌄"}</i></button>
        {settingsOpen && <div className="settings-body">
          <label>数据源表<select value={tableId} disabled={!connected || busy} onChange={e => changeSourceTable(e.target.value)}><option value="">选择数据表</option>{tables.map(table => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>
          <label>车辆名称字段<select value={vehicleField} onChange={e => setVehicleField(e.target.value)}><option value="">不分车辆（整体统计）</option>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          <label>日期字段<select value={dateField} onChange={e => setDateField(e.target.value)}><option value="">选择日期/开始时间</option>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          <label>实际使用时长字段<select value={durationField} onChange={e => setDurationField(e.target.value)}><option value="">选择 ACC 点火时长</option>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          <label>时长单位<select value={unit} onChange={e => setUnit(e.target.value as Unit)}><option value="hour">小时</option><option value="minute">分钟</option><option value="second">秒</option></select></label>
          <label>使用率公式<input className="formula-input" value={formula} onChange={e => setFormula(e.target.value.toUpperCase())}/></label>
          <div className="formula-help"><b>可用变量</b><code>ACC_SUM</code><code>ACC_AVG</code><code>RECORDS</code><code>WORKDAYS</code><code>AVAILABLE_HOURS</code><small>公式结果使用小数表示：0.3 = 30%</small></div>
          {formulaError && <div className="formula-error">公式错误：{formulaError}</div>}
        </div>}
        <button className="primary settings-read" disabled={!connected || busy || !!formulaError} onClick={readTable}>{busy ? "处理中…" : "读取当前表格"}</button>
        <div className="note"><b>默认统计口径</b><br/>每辆车的工作日 ACC 点火时长合计 ÷（工作日数 × 24 小时）。一天内的多段记录会自动相加。</div>
      </aside>
      <section>
        <div className="panel range"><div><h2>统计范围</h2><p>自定义日期，或快捷查看上周、本周、本月</p></div><button onClick={() => quick("lastWeek")}>上周</button><button onClick={() => quick("week")}>本周</button><button onClick={() => quick("month")}>本月</button><label>开始日期<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>结束日期<input type="date" value={to} max={inputDate(now)} onChange={e => setTo(e.target.value)}/></label></div>
        {message && <div className="message">{message}</div>}
        <div className="metrics"><Metric title={vehicleStats.length > 1 ? "平均车辆使用率" : "车辆使用率"} value={`${(rate * 100).toFixed(1)}%`} blue/><Metric title="统计工作日" value={`${days} 天`}/><Metric title="实际使用时长合计" value={`${total.toFixed(2)} h`}/></div>
        <div className="panel chart"><div className="charthead"><div><h2>车辆使用率排行</h2><p>按当前公式从高到低排列，点击任意车辆直接打开原数据表对应记录</p></div><div className="formula-summary"><small>当前公式</small><code>{formula}</code></div></div>
          {rankedVehicleStats.length ? <ResponsiveContainer width="100%" height={Math.max(250, rankedVehicleStats.length * 46 + 42)}>
            <BarChart data={rankedVehicleStats} layout="vertical" margin={{ top: 14, right: 66, left: 12, bottom: 2 }}>
              <CartesianGrid horizontal={false} stroke="#edf1f7"/>
              <XAxis type="number" axisLine={false} tickLine={false} domain={[0, (max: number) => Math.max(0.1, max * 1.18)]} tickFormatter={v => `${Math.round(v * 100)}%`} tick={{ fill: "#8a94a6", fontSize: 11 }}/>
              <YAxis type="category" dataKey="vehicle" width={vehicleAxisWidth} axisLine={false} tickLine={false} interval={0} tick={{ fill: "#354057", fontSize: 12 }}/>
              <Tooltip cursor={{ fill: "#f5f7fb" }} formatter={v => [`${(Number(v) * 100).toFixed(2)}%`, "车辆使用率"]}/>
              <Bar className="rank-bar" dataKey="rate" fill="#4c72ff" radius={[0, 8, 8, 0]} barSize={20} onClick={openVehicleDetail}>
                <LabelList dataKey="rate" position="right" formatter={(v: number) => `${(Number(v) * 100).toFixed(1)}%`} fill="#3152ad" fontSize={11} fontWeight={700}/>
              </Bar>
            </BarChart>
          </ResponsiveContainer> : <ChartEmpty text="读取表格后，这里会按车辆显示使用率排行"/>}
        </div>
        <div className="panel chart"><div className="charthead"><div><h2>车辆使用率趋势</h2><p>各周期按对应工作日数 × 24 小时计算</p></div><div className="toggle"><button className={period === "day" ? "active" : ""} onClick={() => setPeriod("day")}>按日</button><button className={period === "week" ? "active" : ""} onClick={() => setPeriod("week")}>按周</button><button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>按月</button></div></div>
          {vehicleSeries.length ? <><div className="vehicle-filter-head"><b>车辆筛选</b><small>点击车辆名称可隐藏或恢复</small>{hiddenVehicles.size > 0 && <button onClick={() => setHiddenVehicles(new Set())}>全部显示</button>}</div><div className="vehicle-filter">{vehicleSeries.map(series => { const hidden = hiddenVehicles.has(series.vehicle); return <button key={series.key} className={hidden ? "hidden" : ""} aria-pressed={!hidden} onClick={() => toggleVehicle(series.vehicle)}><span style={{ background: hidden ? "#b9c1cf" : series.color }}/>{series.vehicle}</button>; })}</div>{visibleVehicleSeries.length ? <ResponsiveContainer width="100%" height={310}><LineChart data={trend} margin={{ top: 18, right: 14, left: -8, bottom: 2 }}><CartesianGrid vertical={false} stroke="#edf1f7"/><XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#7b8699", fontSize: 11 }} dy={8}/><YAxis axisLine={false} tickLine={false} domain={[0, (max: number) => Math.max(0.1, max * 1.16)]} tickFormatter={v => `${Math.round(v * 100)}%`} tick={{ fill: "#8a94a6", fontSize: 11 }}/><Tooltip formatter={(v, name) => [`${(Number(v) * 100).toFixed(2)}%`, String(name)]}/>{visibleVehicleSeries.map(series => <Line key={series.key} type="monotone" dataKey={series.key} name={series.vehicle} stroke={series.color} strokeWidth={2.4} dot={{ r: 3, strokeWidth: 2, fill: "#fff" }} activeDot={{ r: 5 }} connectNulls/>)}</LineChart></ResponsiveContainer> : <ChartEmpty text="所有车辆已隐藏，点击上方车辆名称即可恢复"/>}</> : <ChartEmpty text="读取表格后，这里会显示每辆车的日/周/月趋势"/>}
        </div>
        <div className="panel write"><div><h2>回写统计结果</h2><p>按“周期 × 车辆”新建统计数据表，不修改原始数据</p></div><button disabled={!rows.length || busy || !!formulaError} onClick={writeBack}>回写到飞书</button></div>
      </section>
    </div>
  </main>;
}

function Metric({ title, value, blue = false }: { title: string; value: string; blue?: boolean }) {
  return <div className={`metric ${blue ? "blue" : ""}`}><small>{title}</small><strong>{value}</strong></div>;
}

function ChartEmpty({ text }: { text: string }) {
  return <div className="chart-empty"><span>↗</span><b>暂无图表数据</b><small>{text}</small></div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
