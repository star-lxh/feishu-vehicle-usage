import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { bitable, FieldType, type IFieldMeta, type ITableMeta } from "@lark-base-open/js-sdk";
import { addDays, endOfMonth, endOfWeek, format, isAfter, isBefore, isValid, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import "./style.css";

type Period = "week" | "month";
type Unit = "hour" | "minute" | "second";
type Datum = { date: Date; hours: number };
type Trend = { key: string; label: string; hours: number; workdays: number; rate: number };

const now = new Date();
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
const groupKey = (d: Date, p: Period) => p === "week" ? format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd") : format(d, "yyyy-MM");
function groupLabel(d: Date, p: Period) {
  return p === "month" ? format(d, "M月") : `${format(startOfWeek(d, { weekStartsOn: 1 }), "M.d")}–${format(endOfWeek(d, { weekStartsOn: 1 }), "M.d")}`;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [tables, setTables] = useState<ITableMeta[]>([]);
  const [tableId, setTableId] = useState("");
  const [tableName, setTableName] = useState("当前数据表");
  const [fields, setFields] = useState<IFieldMeta[]>([]);
  const [dateField, setDateField] = useState("");
  const [durationField, setDurationField] = useState("");
  const [unit, setUnit] = useState<Unit>("hour");
  const [from, setFrom] = useState(inputDate(startOfMonth(now)));
  const [to, setTo] = useState(inputDate(now));
  const [period, setPeriod] = useState<Period>("week");
  const [rows, setRows] = useState<Datum[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSourceTable = useCallback(async (id: string, tableMetas: ITableMeta[]) => {
    const table = await bitable.base.getTableById(id);
    const metas = await table.getFieldMetaList();
    setTableId(id);
    setTableName(tableMetas.find(item => item.id === id)?.name ?? await table.getName());
    setFields(metas);
    setRows([]);
    const d = metas.find(f => /日期|时间|date/i.test(f.name)) ?? metas.find(f => [FieldType.DateTime, FieldType.CreatedTime].includes(f.type));
    const h = metas.find(f => /ACC.*点火|点火.*时长|实际.*时长/i.test(f.name)) ?? metas.find(f => /时长|duration/i.test(f.name));
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
          if (date && isWorkday(date)) list.push({ date, hours: asHours(numeric(record.fields[durationField]), unit) });
        }
        pageToken = page.hasMore ? page.pageToken : undefined;
      } while (pageToken !== undefined);
      setRows(list); setMessage(`已读取 ${list.length} 条工作日记录`);
    } catch { setMessage("读取失败，请确认插件拥有当前多维表格的读取权限"); }
    finally { setBusy(false); }
  }

  const selected = useMemo(() => {
    const a = parseISO(from), b = parseISO(to);
    return rows.filter(r => !isBefore(r.date, a) && !isAfter(r.date, b));
  }, [rows, from, to]);
  const total = useMemo(() => selected.reduce((s, r) => s + r.hours, 0), [selected]);
  const days = useMemo(() => countWorkdays(parseISO(from), parseISO(to)), [from, to]);
  const rate = days ? total / (days * 24) : 0;
  const trend = useMemo<Trend[]>(() => {
    const map = new Map<string, Datum[]>();
    for (const row of selected) { const key = groupKey(row.date, period); map.set(key, [...(map.get(key) ?? []), row]); }
    const a = parseISO(from), b = parseISO(to);
    for (let d = a; !isAfter(d, b); d = period === "week" ? addDays(startOfWeek(d, { weekStartsOn: 1 }), 7) : addDays(endOfMonth(d), 1)) {
      const key = groupKey(d, period); if (!map.has(key)) map.set(key, []);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => {
      const anchor = period === "week" ? parseISO(key) : parseISO(`${key}-01`);
      const ps = period === "week" ? startOfWeek(anchor, { weekStartsOn: 1 }) : startOfMonth(anchor);
      const pe = period === "week" ? endOfWeek(anchor, { weekStartsOn: 1 }) : endOfMonth(anchor);
      const x = isBefore(ps, a) ? a : ps, y = isAfter(pe, b) ? b : pe;
      const workdays = countWorkdays(x, y), hours = rs.reduce((s, r) => s + r.hours, 0);
      return { key, label: groupLabel(anchor, period), hours, workdays, rate: workdays ? hours / (workdays * 24) : 0 };
    });
  }, [selected, from, to, period]);

  function quick(p: Period) {
    setFrom(inputDate(p === "week" ? startOfWeek(now, { weekStartsOn: 1 }) : startOfMonth(now)));
    setTo(inputDate(now)); setPeriod(p);
  }
  async function writeBack() {
    if (!rows.length) return setMessage("请先读取当前表格");
    setBusy(true); setMessage("");
    try {
      const { tableId } = await bitable.base.addTable({ name: `使用率统计_${format(new Date(), "MMdd_HHmm")}` });
      const table = await bitable.base.getTable(tableId);
      const existing = await table.getFieldMetaList();
      const primary = existing.find(f => f.isPrimary) ?? existing[0];
      await table.setField(primary.id, { name: period === "week" ? "统计周" : "统计月" });
      const h = await table.addField({ type: FieldType.Number, name: "实际使用时长(h)" });
      const d = await table.addField({ type: FieldType.Number, name: "工作日数" });
      const a = await table.addField({ type: FieldType.Number, name: "可用时长(h)" });
      const r = await table.addField({ type: FieldType.Number, name: "车辆使用率" });
      await table.addRecords(trend.map(v => ({ fields: { [primary.id]: v.label, [h]: +v.hours.toFixed(2), [d]: v.workdays, [a]: v.workdays * 24, [r]: +v.rate.toFixed(4) } })));
      setMessage("统计结果已回写到新的数据表");
    } catch { setMessage("回写失败，请确认你拥有编辑权限"); }
    finally { setBusy(false); }
  }

  return <main>
    <header><div className="logo">▥</div><div><b>车辆使用率统计</b><small>工作日 × 24 小时口径</small></div><button className={`status ${connected ? "ok" : "warn"}`} onClick={connected || connecting ? undefined : connect}>{connected ? `已连接 · ${tableName}` : connecting ? "正在连接飞书…" : "连接失败 · 点此重试"}</button></header>
    <div className="layout">
      <aside className="panel"><h2>字段设置</h2>
        <label>数据源表<select value={tableId} disabled={!connected || busy} onChange={e => changeSourceTable(e.target.value)}><option value="">选择数据表</option>{tables.map(table => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>
        <label>日期字段<select value={dateField} onChange={e => setDateField(e.target.value)}><option value="">选择日期/开始时间</option>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>实际使用时长字段<select value={durationField} onChange={e => setDurationField(e.target.value)}><option value="">选择 ACC 点火时长</option>{fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <label>时长单位<select value={unit} onChange={e => setUnit(e.target.value as Unit)}><option value="hour">小时</option><option value="minute">分钟</option><option value="second">秒</option></select></label>
        <button className="primary" disabled={!connected || busy} onClick={readTable}>{busy ? "处理中…" : "读取当前表格"}</button>
        <div className="note"><b>统计口径</b><br/>仅汇总周一至周五的 ACC 点火时长。一天内的多段记录会自动相加。</div>
      </aside>
      <section>
        <div className="panel range"><div><h2>统计范围</h2><p>自定义日期，或快捷查看本周、本月</p></div><button onClick={() => quick("week")}>本周</button><button onClick={() => quick("month")}>本月</button><label>开始日期<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>结束日期<input type="date" value={to} max={inputDate(now)} onChange={e => setTo(e.target.value)}/></label></div>
        {message && <div className="message">{message}</div>}
        <div className="metrics"><Metric title="车辆使用率" value={`${(rate * 100).toFixed(1)}%`} blue/><Metric title="统计工作日" value={`${days} 天`}/><Metric title="实际使用时长" value={`${total.toFixed(2)} h`}/></div>
        <div className="panel chart"><div className="charthead"><div><h2>使用率趋势</h2><p>各周期按对应工作日数 × 24 小时计算</p></div><div className="toggle"><button className={period === "week" ? "active" : ""} onClick={() => setPeriod("week")}>按周</button><button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>按月</button></div></div>
          <ResponsiveContainer width="100%" height={280}><AreaChart data={trend}><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3370ff" stopOpacity=".28"/><stop offset="1" stopColor="#3370ff" stopOpacity=".02"/></linearGradient></defs><CartesianGrid vertical={false} stroke="#e8edf5"/><XAxis dataKey="label" axisLine={false} tickLine={false}/><YAxis axisLine={false} tickLine={false} tickFormatter={v => `${Math.round(v * 100)}%`}/><Tooltip formatter={v => [`${(Number(v) * 100).toFixed(1)}%`, "车辆使用率"]}/><Area type="monotone" dataKey="rate" stroke="#3370ff" strokeWidth={2.5} fill="url(#fill)"/></AreaChart></ResponsiveContainer>
        </div>
        <div className="panel write"><div><h2>回写统计结果</h2><p>新建周/月统计数据表，不修改原始数据</p></div><button disabled={!rows.length || busy} onClick={writeBack}>回写到飞书</button></div>
      </section>
    </div>
  </main>;
}

function Metric({ title, value, blue = false }: { title: string; value: string; blue?: boolean }) {
  return <div className={`metric ${blue ? "blue" : ""}`}><small>{title}</small><strong>{value}</strong></div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
