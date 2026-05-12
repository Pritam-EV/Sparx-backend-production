// src/features/owner/OwnerReports.js
// ─── Corrected to use real backend endpoints ─────────────────────────────────

import React, { useCallback, useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress,
  Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControl, IconButton, MenuItem, Select, Snackbar, Stack,
  TextField, Tooltip, Typography,
} from "@mui/material";
import AccountBalanceIcon  from "@mui/icons-material/AccountBalance";
import AssessmentIcon      from "@mui/icons-material/Assessment";
import CheckCircleIcon     from "@mui/icons-material/CheckCircle";
import ContentCopyIcon     from "@mui/icons-material/ContentCopy";
import DownloadIcon        from "@mui/icons-material/Download";
import ElectricBoltIcon    from "@mui/icons-material/ElectricBolt";
import HourglassEmptyIcon  from "@mui/icons-material/HourglassEmpty";
import PictureAsPdfIcon    from "@mui/icons-material/PictureAsPdf";
import RefreshIcon         from "@mui/icons-material/Refresh";
import TableChartIcon      from "@mui/icons-material/TableChart";
import TrendingUpIcon      from "@mui/icons-material/TrendingUp";
import PaymentsIcon        from "@mui/icons-material/Payments";

// ─── Constants ────────────────────────────────────────────────────────────────

const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const MONTHS = [
  { v: 1, l: "January" }, { v: 2,  l: "February" }, { v: 3,  l: "March" },
  { v: 4, l: "April"   }, { v: 5,  l: "May"       }, { v: 6,  l: "June" },
  { v: 7, l: "July"    }, { v: 8,  l: "August"    }, { v: 9,  l: "September" },
  { v: 10, l: "October" }, { v: 11, l: "November"  }, { v: 12, l: "December" },
];

const CY   = new Date().getFullYear();
const YEARS = [CY, CY - 1, CY - 2];

const BASE = process.env.REACT_APP_Backend_API_Base_URL;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtMoney = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (m, y) => `${MONTHS.find((x) => x.v === m)?.l} ${y}`;

/** YYYY-MM string from numeric month + year */
const toMonthStr = (m, y) =>
  `${y}-${String(m).padStart(2, "0")}`;

const getUserId = () => {
  try {
    return JSON.parse(atob(localStorage.getItem("token").split(".")[1])).userId;
  } catch { return null; }
};

const authFetch = async (url, opts = {}) => {
  const token = localStorage.getItem("token");
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || j?.message || `HTTP ${res.status}`);
  }
  return res;
};

const downloadBlob = (blob, name) => {
  const a  = document.createElement("a");
  a.href   = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function Row({ label, value, highlight, debit, note }) {
  return (
    <Box sx={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      px: 1.5, py: 0.9, borderRadius: 1.5, mb: 0.5,
      bgcolor: highlight ? "#f0fdfd" : debit ? "#fef2f2" : "#f9fafb",
    }}>
      <Box>
        <Typography sx={{ fontSize: 13, fontWeight: 500, fontFamily: FONT, color: debit ? "#dc2626" : "#334155" }}>
          {label}
        </Typography>
        {note && <Typography sx={{ fontSize: 10, color: "#94a3b8", fontFamily: FONT }}>{note}</Typography>}
      </Box>
      <Typography sx={{ fontSize: 14, fontWeight: 700, fontFamily: FONT, color: highlight ? "#0f766e" : debit ? "#dc2626" : "#000" }}>
        {value}
      </Typography>
    </Box>
  );
}

function SectionLabel({ children }) {
  return (
    <Typography sx={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.8px",
      textTransform: "uppercase", color: "#94a3b8", mt: 1.5, mb: 0.75, fontFamily: FONT,
    }}>
      {children}
    </Typography>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function OwnerReports() {
  // ── Period + Project ──
  const [month,    setMonth]    = useState(new Date().getMonth() + 1);
  const [year,     setYear]     = useState(CY);
  const [projects, setProjects] = useState([]);
  const [project,  setProject]  = useState("");

  // ── Report ──
  const [report,  setReport]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState(null);

  // ── Payment dialog ──
  const [payDialog,  setPayDialog]  = useState(false);
  const [txnId,      setTxnId]      = useState("");
  const [amtPaid,    setAmtPaid]    = useState("");
  const [payLoading, setPayLoading] = useState(false);
  const [payErr,     setPayErr]     = useState(null);
  const [payDone,    setPayDone]    = useState(false);

  // ── Downloads ──
  const [dlExcel, setDlExcel] = useState(false);
  const [dlPdf,   setDlPdf]   = useState(false);
  const [dlEB,    setDlEB]    = useState(false);

  // ── Snackbar ──
  const [snack, setSnack] = useState({ open: false, msg: "" });
  const toast = (msg) => setSnack({ open: true, msg });

  // ─── Load owner's VJRA projects (once) ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res  = await authFetch(`${BASE}/api/reports/owner/projects`);
        const data = await res.json();
        const list = data.projects || [];
        setProjects(list);
        if (list.length) setProject(list[0].project);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, []);

  // ─── Fetch report ─────────────────────────────────────────────────────────
  const fetchReport = useCallback(async () => {
    if (!project) return;
    try {
      setLoading(true);
      setErr(null);
      setReport(null);
      const mon = toMonthStr(month, year);
      const res  = await authFetch(`${BASE}/api/reports/owner/monthly?project=${encodeURIComponent(project)}&month=${mon}`);
      const data = await res.json();
      setReport(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [project, month, year]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // ─── Record payment ───────────────────────────────────────────────────────
  const handleRecordPayment = async () => {
    if (!txnId.trim() || !amtPaid) {
      setPayErr("Transaction ID and amount are required.");
      return;
    }
    const ebId = report?.ebData?.ebId;
    if (!ebId) return;
    try {
      setPayLoading(true);
      setPayErr(null);
      await authFetch(`${BASE}/api/eb/owner/${ebId}/record-payment`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ txnId: txnId.trim(), amountPaid: Number(amtPaid) }),
      });
      setPayDone(true);
      setTimeout(() => {
        setPayDialog(false);
        setPayDone(false);
        setTxnId("");
        setAmtPaid("");
        fetchReport();
      }, 1600);
    } catch (e) {
      setPayErr(e.message);
    } finally {
      setPayLoading(false);
    }
  };

  // ─── Download CSV ─────────────────────────────────────────────────────────
  const handleDownloadExcel = async () => {
    if (!report) return;
    try {
      setDlExcel(true);
      const eb = report.ebData || {};
      const rd = report.reportData || {};
      const rows = [
        ["Sparx EV — Monthly Report"],
        [`Period: ${monthLabel(month, year)}`],
        [`Owner: ${report.ownerName || ""}`],
        [`Project: ${report.projectName || ""}`],
        [],
        ["ELECTRICITY BILL BREAKDOWN (MSEB)"],
        ["Charge", "Amount (₹)"],
        ["Wheeling Charges",           eb.wheelingCharges       ?? 0],
        ["Demand Charges",             eb.demandCharges         ?? 0],
        ["Energy Charges (VJRA bears)",eb.energyCharges         ?? 0],
        ["FAC",                        eb.fac                   ?? 0],
        ["Fixed Charges",              eb.fixedCharges          ?? 0],
        ["Electricity Duty",           eb.electricityDuty       ?? 0],
        ["Meter Rent",                 eb.meterRent             ?? 0],
        ["Power Factor Adjustment",    eb.powerFactorAdjustment ?? 0],
        ["Delayed Payment Charges",    eb.delayedPaymentCharges ?? 0],
        ["Regulatory Charges",         eb.regulatoryCharges     ?? 0],
        ["Other Charges",              eb.otherCharges          ?? 0],
        ["TOTAL MSEB BILL",            eb.totalBillAmount       ?? 0],
        ["Amount Owner Owes VJRA",     eb.totalOwnerPayable     ?? 0],
        [],
        ["MONTHLY REVENUE REPORT"],
        ["Item", "Amount (₹)"],
        ["Total Revenue (incl. GST)",         rd.grossRevenue       ?? 0],
        ["(-) GST @ 18%",                     rd.gstAmount          ?? 0],
        ["(-) VJRA Commission",               rd.vjraCommission     ?? 0],
        ["(-) Payment Gateway Charges",       rd.pgCharges          ?? 0],
        ["(-) Energy Charges (VJRA bears)",   rd.energyChargesVjra  ?? 0],
        ["Net Payout to Owner",               rd.netPayout          ?? 0],
        [],
        ["Payment Status",  report.paymentStatus || "Pending"],
        ...(report.paymentRecord
          ? [
              ["Transaction ID", report.paymentRecord.transactionId],
              ["Amount Paid",    report.paymentRecord.amountPaid],
            ]
          : []),
      ];
      const csv  = rows.map((r) => r.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      downloadBlob(blob, `Sparx_Report_${toMonthStr(month, year)}_${project}.csv`);
      toast("CSV downloaded!");
    } catch { toast("Download failed."); }
    finally { setDlExcel(false); }
  };

  // ─── Download Report PDF ──────────────────────────────────────────────────
  const handleDownloadPdf = async () => {
    try {
      setDlPdf(true);
      const mon = toMonthStr(month, year);
      const res = await authFetch(
        `${BASE}/api/reports/owner/pdf?project=${encodeURIComponent(project)}&month=${mon}`
      );
      const blob = await res.blob();
      downloadBlob(blob, `Sparx_Report_${mon}_${project}.pdf`);
      toast("Report PDF downloaded!");
    } catch { toast("PDF download failed."); }
    finally { setDlPdf(false); }
  };

  // ─── Download EB PDF ──────────────────────────────────────────────────────
  const handleDownloadEB = async () => {
    const ebId = report?.ebData?.ebId;
    if (!ebId || !report?.ebData?.hasPdf) return;
    try {
      setDlEB(true);
      // Get signed URL from backend
      const res  = await authFetch(`${BASE}/api/eb/${ebId}/download-pdf`);
      const data = await res.json();
      window.open(data.url, "_blank");
      toast("EB PDF opened!");
    } catch { toast("EB PDF download failed."); }
    finally { setDlEB(false); }
  };

  // ─── Copy bank detail ─────────────────────────────────────────────────────
  const copy = (text, label) => {
    navigator.clipboard.writeText(text).then(() => toast(`${label} copied!`));
  };

  // ─── Derived ──────────────────────────────────────────────────────────────
  const status    = report?.status;
  const eb        = report?.ebData   || {};
  const rd        = report?.reportData || {};
  const bank      = report?.bankDetails || {};
  const hasEB     = status === "EB_UPLOADED" || status === "EB_PROCESSED";
  const hasReport = status === "EB_PROCESSED";

  const selectSx = {
    bgcolor: "#f9fafb", fontSize: 13, fontWeight: 500, fontFamily: FONT,
    "& .MuiOutlinedInput-notchedOutline": { borderColor: "#e5e7eb" },
    "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: "#04BFBF" },
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Box sx={{ maxWidth: 780, mx: "auto", py: 3, px: { xs: 2, md: 3 }, fontFamily: FONT }}>

      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={3} gap={1.5}>
        <Box>
          <Typography sx={{ fontWeight: 900, fontSize: { xs: 22, sm: 26 }, letterSpacing: "-0.5px", fontFamily: FONT }}>Reports</Typography>
          <Typography sx={{ color: "#64748b", fontSize: 12, fontFamily: FONT }}>Monthly EB breakdown and revenue payout statement</Typography>
        </Box>
        <Tooltip title="Refresh" arrow>
          <IconButton onClick={fetchReport} disabled={loading} size="small"
            sx={{ bgcolor: "#04BFBF", color: "#fff", width: 32, height: 32,
              "&:hover": { bgcolor: "#03a6a6", transform: "rotate(180deg)" },
              "&:disabled": { bgcolor: "#cbd5e1" }, transition: "all 0.4s" }}>
            <RefreshIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      {/* Filters */}
      <Card sx={CARD}>
        <CardContent sx={{ p: 1.5 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems="center">
            {/* Project picker — shown only if owner has multiple projects */}
            {projects.length > 1 && (
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <Select value={project} onChange={(e) => setProject(e.target.value)} sx={selectSx}>
                  {projects.map((p) => (
                    <MenuItem key={p.project} value={p.project} sx={{ fontSize: 13 }}>
                      {p.project}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <FormControl size="small" sx={{ minWidth: 155 }}>
              <Select value={month} onChange={(e) => setMonth(e.target.value)} sx={selectSx}>
                {MONTHS.map((m) => (
                  <MenuItem key={m.v} value={m.v} sx={{ fontSize: 13 }}>{m.l}</MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 100 }}>
              <Select value={year} onChange={(e) => setYear(e.target.value)} sx={selectSx}>
                {YEARS.map((y) => (
                  <MenuItem key={y} value={y} sx={{ fontSize: 13 }}>{y}</MenuItem>
                ))}
              </Select>
            </FormControl>

            {report?.projectName && (
              <Typography sx={{ fontSize: 12, color: "#64748b", fontFamily: FONT }}>
                📍 {report.projectName}
              </Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Loading */}
      {loading && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}>
          <Stack alignItems="center" spacing={1.5}>
            <CircularProgress size={40} thickness={4} sx={{ color: "#04BFBF" }} />
            <Typography sx={{ fontSize: 13, color: "#64748b", fontFamily: FONT }}>
              Loading {monthLabel(month, year)} report…
            </Typography>
          </Stack>
        </Box>
      )}

      {/* Error */}
      {!loading && err && (
        <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>{err}</Alert>
      )}

      {/* ── STATE 1: No EB ── */}
      {!loading && !err && status === "NO_DATA" && (
        <Card sx={{ ...CARD, mt: 2 }}>
          <CardContent sx={{ textAlign: "center", py: 8 }}>
            <HourglassEmptyIcon sx={{ fontSize: 52, color: "#04BFBF", mb: 1.5 }} />
            <Typography sx={{ fontWeight: 700, fontSize: 17, mb: 0.5, fontFamily: FONT }}>
              EB Not Yet Generated
            </Typography>
            <Typography sx={{ color: "#64748b", fontSize: 13, maxWidth: 340, mx: "auto", fontFamily: FONT }}>
              The Electricity Bill for <strong>{monthLabel(month, year)}</strong> has not been uploaded
              by VJRA yet. Please check back once the MSEB bill is processed.
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* ── STATE 2 & 3: EB uploaded ── */}
      {!loading && !err && hasEB && (
        <Stack spacing={2.5} mt={2.5}>

          {/* EB Breakdown */}
          <Card sx={CARD}>
            <CardContent sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} mb={1.5}>
                <ElectricBoltIcon sx={{ fontSize: 20, color: "#04BFBF" }} />
                <Typography sx={{ fontWeight: 800, fontSize: 15, fontFamily: FONT }}>
                  MSEB Electricity Bill — {monthLabel(month, year)}
                </Typography>
              </Stack>

              <SectionLabel>Charge Breakdown</SectionLabel>
              <Row label="Wheeling Charges"             value={fmtMoney(eb.wheelingCharges)} />
              <Row label="Demand Charges"               value={fmtMoney(eb.demandCharges)} />
              <Row label="Energy Charges"               value={fmtMoney(eb.energyCharges)}        note="VJRA bears this component" />
              <Row label="FAC (Fuel Adjustment Charge)" value={fmtMoney(eb.fac)} />
              <Row label="Fixed Charges"                value={fmtMoney(eb.fixedCharges)}          note="Owner bears this component" />
              <Row label="Electricity Duty"             value={fmtMoney(eb.electricityDuty)} />
              <Row label="Meter Rent"                   value={fmtMoney(eb.meterRent)} />
              <Row label="Power Factor Adjustment"      value={fmtMoney(eb.powerFactorAdjustment)} />
              <Row label="Delayed Payment Charges"      value={fmtMoney(eb.delayedPaymentCharges)} />
              <Row label="Regulatory Charges"           value={fmtMoney(eb.regulatoryCharges)} />
              {eb.otherCharges > 0 && (
                <Row label="Other Charges"              value={fmtMoney(eb.otherCharges)} />
              )}
              <Divider sx={{ my: 1.5 }} />
              <Row label="Total MSEB Bill Amount"       value={fmtMoney(eb.totalBillAmount)}   highlight />

              {/* EB PDF */}
              {eb.hasPdf && (
                <Box mt={1.5}>
                  <Button size="small" variant="outlined"
                    startIcon={dlEB ? <CircularProgress size={14} /> : <PictureAsPdfIcon sx={{ fontSize: 16 }} />}
                    onClick={handleDownloadEB} disabled={dlEB}
                    sx={{ fontSize: 12, textTransform: "none", fontFamily: FONT, borderRadius: 1.5,
                      borderColor: "#dc2626", color: "#dc2626",
                      "&:hover": { borderColor: "#b91c1c", bgcolor: "#fef2f2" } }}>
                    Download MSEB EB PDF
                  </Button>
                </Box>
              )}
            </CardContent>
          </Card>

          {/* Pay to VJRA */}
          <Card sx={{ ...CARD, border: "1.5px solid #04BFBF" }}>
            <CardContent sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} mb={1.5}>
                <AccountBalanceIcon sx={{ fontSize: 20, color: "#04BFBF" }} />
                <Typography sx={{ fontWeight: 800, fontSize: 15, fontFamily: FONT }}>
                  Amount Payable to Vjra Technologies
                </Typography>
              </Stack>
              <Typography sx={{ fontSize: 13, color: "#64748b", mb: 2, fontFamily: FONT }}>
                As per your agreement, the owner bears all fixed and infrastructure charges.
                Please transfer the amount below before the MSEB payment due date.
              </Typography>

              {/* Amount pill */}
              <Box sx={{ p: 2, bgcolor: "#000", borderRadius: 2, display: "flex",
                justifyContent: "space-between", alignItems: "center", mb: 2.5 }}>
                <Typography sx={{ fontSize: 13, color: "rgba(255,255,255,0.7)", fontFamily: FONT }}>Amount Due to VJRA</Typography>
                <Typography sx={{ fontSize: 22, fontWeight: 900, color: "#04BFBF", fontFamily: FONT }}>
                  {fmtMoney(report?.amountOwnerOwesVjra)}
                </Typography>
              </Box>

              {/* Bank details */}
              <SectionLabel>Bank Account Details</SectionLabel>
              {[
                ["Account Name",   bank.accountName],
                ["Bank",           bank.bankName],
                ["Account Number", bank.accountNumber],
                ["IFSC Code",      bank.ifsc],
                ["Account Type",   bank.accountType],
              ].map(([label, value]) => (
                <Box key={label} sx={{ display: "flex", justifyContent: "space-between",
                  alignItems: "center", px: 1.5, py: 0.75, bgcolor: "#f9fafb", borderRadius: 1, mb: 0.5 }}>
                  <Typography sx={{ fontSize: 12, color: "#64748b", fontFamily: FONT }}>{label}</Typography>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography sx={{ fontSize: 13, fontWeight: 600, fontFamily: FONT }}>{value}</Typography>
                    <Tooltip title="Copy" arrow>
                      <IconButton size="small" onClick={() => copy(value, label)}
                        sx={{ color: "#94a3b8", p: 0.25, "&:hover": { color: "#04BFBF" } }}>
                        <ContentCopyIcon sx={{ fontSize: 13 }} />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Box>
              ))}

              {/* Payment status / button */}
              <Box mt={2}>
                {report?.paymentStatus === "SUBMITTED" || report?.paymentStatus === "VERIFIED" || report?.paymentStatus === "COMPLETE" ? (
                  <Stack direction="row" alignItems="center" spacing={1}
                    sx={{ p: 1.5, bgcolor: report?.paymentStatus === "COMPLETE" ? "#dcfce7" : "#fef9c3", borderRadius: 1.5 }}>
                    <CheckCircleIcon sx={{ fontSize: 18, color: report?.paymentStatus === "COMPLETE" ? "#16a34a" : "#ca8a04" }} />
                    <Box>
                      <Typography sx={{ fontSize: 13, fontWeight: 700, fontFamily: FONT,
                        color: report?.paymentStatus === "COMPLETE" ? "#16a34a" : "#ca8a04" }}>
                        {{ SUBMITTED: "Payment Submitted — Awaiting VJRA Verification", VERIFIED: "Payment Verified ✓", COMPLETE: "EB Paid to MSEB ✓" }[report.paymentStatus]}
                      </Typography>
                      {report?.paymentRecord?.transactionId && (
                        <Typography sx={{ fontSize: 11, color: "#64748b", fontFamily: FONT }}>
                          Txn ID: {report.paymentRecord.transactionId} • {fmtMoney(report.paymentRecord.amountPaid)}
                        </Typography>
                      )}
                    </Box>
                  </Stack>
                ) : (
                  <Button fullWidth variant="contained"
                    startIcon={<PaymentsIcon />}
                    onClick={() => {
                      setAmtPaid(String(report?.amountOwnerOwesVjra || ""));
                      setTxnId(""); setPayErr(null); setPayDone(false); setPayDialog(true);
                    }}
                    sx={{ bgcolor: "#04BFBF", fontWeight: 700, fontSize: 13,
                      textTransform: "none", borderRadius: 1.5, fontFamily: FONT,
                      "&:hover": { bgcolor: "#03a6a6" } }}>
                    Record Payment to VJRA
                  </Button>
                )}
              </Box>
            </CardContent>
          </Card>

          {/* ── STATE 3: Full report ── */}
          {hasReport && (
            <Card sx={CARD}>
              <CardContent sx={{ p: 2 }}>
                <Stack direction="row" alignItems="center" spacing={1} mb={1.5}>
                  <AssessmentIcon sx={{ fontSize: 20, color: "#04BFBF" }} />
                  <Typography sx={{ fontWeight: 800, fontSize: 15, fontFamily: FONT }}>
                    Monthly Revenue Report — {monthLabel(month, year)}
                  </Typography>
                </Stack>

                <SectionLabel>Revenue</SectionLabel>
                <Row label="Total Revenue (incl. GST)"   value={fmtMoney(rd.grossRevenue)} note={`${rd.sessionsCount} sessions • ${rd.totalEnergy?.toFixed(2)} kWh`} />
                <Row label="(-) GST @ 18%"               value={`-${fmtMoney(rd.gstAmount)}`}  debit />

                <SectionLabel>Deductions</SectionLabel>
                <Row label="(-) Energy Charges (VJRA bears)"  value={`-${fmtMoney(rd.energyChargesVjra)}`}  debit note="VJRA pays this to MSEB" />
                <Row label="(-) VJRA Commission"              value={`-${fmtMoney(rd.vjraCommission)}`}     debit />
                <Row label="(-) Payment Gateway Charges"      value={`-${fmtMoney(rd.pgCharges)}`}          debit />

                <SectionLabel>Fixed Charges (Owner-Borne)</SectionLabel>
                <Row label="Fixed & Other Charges"            value={fmtMoney(rd.fixedChargesOwner)} note="Collected separately from owner" />

                <Divider sx={{ my: 1.5 }} />

                {/* Net payout highlight */}
                <Box sx={{ p: 2, bgcolor: "#fb923c", borderRadius: 2,
                  display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Box>
                    <Typography sx={{ fontSize: 13, color: "rgba(255,255,255,0.85)", fontFamily: FONT }}>Net Payout to Owner</Typography>
                    <Typography sx={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontFamily: FONT }}>Credited to your account</Typography>
                  </Box>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <TrendingUpIcon sx={{ fontSize: 22, color: "#fff" }} />
                    <Typography sx={{ fontSize: 24, fontWeight: 900, color: "#fff", fontFamily: FONT }}>
                      {fmtMoney(rd.netPayout)}
                    </Typography>
                  </Stack>
                </Box>

                {/* Downloads */}
                <SectionLabel>Downloads</SectionLabel>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} mt={0.5}>
                  <Button fullWidth variant="outlined"
                    startIcon={dlExcel ? <CircularProgress size={14} /> : <TableChartIcon sx={{ fontSize: 16 }} />}
                    onClick={handleDownloadExcel} disabled={dlExcel}
                    sx={{ fontSize: 12, textTransform: "none", fontFamily: FONT, borderRadius: 1.5,
                      borderColor: "#16a34a", color: "#16a34a",
                      "&:hover": { borderColor: "#15803d", bgcolor: "#f0fdf4" } }}>
                    Download as Excel (CSV)
                  </Button>
                  <Button fullWidth variant="outlined"
                    startIcon={dlPdf ? <CircularProgress size={14} /> : <DownloadIcon sx={{ fontSize: 16 }} />}
                    onClick={handleDownloadPdf} disabled={dlPdf}
                    sx={{ fontSize: 12, textTransform: "none", fontFamily: FONT, borderRadius: 1.5,
                      borderColor: "#2563eb", color: "#2563eb",
                      "&:hover": { borderColor: "#1d4ed8", bgcolor: "#eff6ff" } }}>
                    Download Report PDF
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          )}
        </Stack>
      )}

      {/* Record Payment Dialog */}
      <Dialog open={payDialog} onClose={() => { if (!payLoading) setPayDialog(false); }}
        maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 2.5 } }}>
        <DialogTitle sx={{ fontWeight: 800, fontSize: 16, fontFamily: FONT, pb: 0.5 }}>
          Record Payment to VJRA
        </DialogTitle>
        <DialogContent sx={{ pt: 1.5 }}>
          {payDone ? (
            <Stack alignItems="center" spacing={1.5} py={3}>
              <CheckCircleIcon sx={{ fontSize: 52, color: "#16a34a" }} />
              <Typography sx={{ fontWeight: 700, fontSize: 15, color: "#16a34a", fontFamily: FONT }}>
                Payment recorded!
              </Typography>
            </Stack>
          ) : (
            <Stack spacing={2} mt={0.5}>
              <Typography sx={{ fontSize: 13, color: "#64748b", fontFamily: FONT }}>
                After completing the bank transfer, enter your transaction / UTR ID and the exact amount paid.
              </Typography>
              <TextField label="Transaction / UTR ID *" value={txnId}
                onChange={(e) => setTxnId(e.target.value)} size="small" fullWidth
                InputProps={{ style: { fontSize: 13, fontFamily: FONT } }}
                InputLabelProps={{ style: { fontSize: 13 } }} />
              <TextField label="Amount Paid (₹) *" value={amtPaid} type="number"
                onChange={(e) => setAmtPaid(e.target.value)} size="small" fullWidth
                inputProps={{ min: 0, step: "0.01" }}
                InputProps={{ startAdornment: <Typography sx={{ mr: 0.5, color: "#94a3b8", fontSize: 13 }}>₹</Typography>,
                  style: { fontSize: 13, fontFamily: FONT } }}
                InputLabelProps={{ style: { fontSize: 13 } }} />
              {payErr && <Alert severity="error" sx={{ fontSize: 12 }}>{payErr}</Alert>}
            </Stack>
          )}
        </DialogContent>
        {!payDone && (
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setPayDialog(false)} disabled={payLoading}
              sx={{ fontSize: 13, textTransform: "none", fontFamily: FONT, color: "#64748b" }}>
              Cancel
            </Button>
            <Button variant="contained" onClick={handleRecordPayment} disabled={payLoading}
              sx={{ fontSize: 13, textTransform: "none", fontFamily: FONT,
                bgcolor: "#04BFBF", fontWeight: 700, borderRadius: 1.5,
                "&:hover": { bgcolor: "#03a6a6" } }}>
              {payLoading ? <CircularProgress size={18} sx={{ color: "#fff" }} /> : "Confirm Payment"}
            </Button>
          </DialogActions>
        )}
      </Dialog>

      {/* Snackbar */}
      <Snackbar open={snack.open} autoHideDuration={3000}
        onClose={() => setSnack({ open: false, msg: "" })}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        message={<Typography sx={{ fontSize: 13, fontFamily: FONT }}>{snack.msg}</Typography>}
        ContentProps={{ sx: { bgcolor: "#1a1a1a", borderRadius: 2 } }} />
    </Box>
  );
}

const CARD = {
  borderRadius: 2,
  border: "1px solid #e5e7eb",
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  background: "#fff",
};