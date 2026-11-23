import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useDismiss } from "../ui/index.jsx";

const PrGlyph = ({ merged }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="4" cy="3.5" r="1.75" />
    <circle cx="4" cy="12.5" r="1.75" />
    <circle cx="12" cy="12.5" r="1.75" />
    {merged ? (
      <path d="M4 5.25v5.5M5.5 4.5c3 0 6.5 1 6.5 6.25" />
    ) : (
      <path d="M4 5.25v5.5M12 10.75V6.5c0-1.5-1-2.5-2.5-2.5H7.5M9 2.5 7.5 4 9 5.5" />
    )}
  </svg>
);

/** {pass, fail, pending} from a thread's PR (summary) or a chat's cached PR (flat counts). */
export function prSummary(pr) {
  return (
    pr?.summary || {
      pass: pr?.pass || 0,
      fail: pr?.fail || 0,
      pending: pr?.pending || 0,
    }
  );
}

export function ciState(pr) {
  const s = prSummary(pr);
  return s.fail ? "fail" : s.pending ? "pending" : s.pass ? "pass" : "none";
}

const DISMISS_KEY = "prbar-dismissed";
const dismissed = () => {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}");
  } catch {
    return {};
  }
};

/**
 * The pull request the chat or thread works on, pinned above the composer: number, branch, size and CI,
 * with a dropdown of the checks (fetched from the Details lookup when opened). × hides it until the PR's
 * state or CI changes.
 */
export default function PrBar({ pr, sessionId, fallbackBranch }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState("");
  const [hiddenTick, setHiddenTick] = useState(0);
  const ref = useRef(null);
  useDismiss(open, () => setOpen(false), ref);
  const ci = ciState(pr);
  const stamp = pr ? `${pr.state}:${ci}` : "";

  useEffect(() => {
    if (!open || !sessionId || !pr) return;
    let live = true;
    setErr("");
    api(`/api/sessions/${sessionId}/pr`)
      .then((r) => {
        if (!live) return;
        const all = [r.pr, ...(r.linked || [])].filter(Boolean);
        const hit = all.find((x) => x.number === pr.number);
        if (hit) setDetail(hit);
        else if (r.error || r.reason) setErr(r.error || r.reason);
      })
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [open, sessionId, pr?.number]);

  if (!pr?.url) return null;
  void hiddenTick;
  if (dismissed()[pr.url] === stamp) return null;

  const st =
    pr.state === "MERGED"
      ? "merged"
      : pr.state === "CLOSED"
        ? "closed"
        : pr.state === "DRAFT"
          ? "draft"
          : "open";
  const sum = prSummary(detail && detail.number === pr.number ? detail : pr);
  const checks = detail?.number === pr.number ? detail.checks || [] : null;
  const ciTitle =
    ci === "none"
      ? "No checks reported"
      : `${sum.pass} passing, ${sum.fail} failing, ${sum.pending} running`;
  const hide = () => {
    const d = dismissed();
    d[pr.url] = stamp;
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
    } catch {}
    setHiddenTick((n) => n + 1);
  };

  return (
    <div className={`prbar menu-wrap ${st}`} ref={ref}>
      <a
        className="prbar-main"
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`${pr.title || ""}${pr.linked ? " · linked in this chat" : ""}`}
      >
        <span className={`prbar-icon ${st}`}>
          <PrGlyph merged={st === "merged"} />
        </span>
        <span className="prbar-num">#{pr.number}</span>
        <span className="prbar-branch">{pr.head || fallbackBranch || ""}</span>
      </a>
      {st !== "open" && (
        <span className={`prbar-state ${st}`}>
          {st === "merged" ? "Merged" : st === "closed" ? "Closed" : "Draft"}
        </span>
      )}
      {pr.additions != null && (
        <span
          className="prbar-diff"
          title={`${pr.additions} added, ${pr.deletions} removed`}
        >
          <span className="add">+{pr.additions}</span>{" "}
          <span className="del">−{pr.deletions}</span>
        </span>
      )}
      <button
        className={`prbar-ci ${ci}`}
        aria-expanded={open}
        title={ciTitle}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot" /> CI{ci === "fail" ? ` ${sum.fail}` : ""}{" "}
        <span className="chev">⌄</span>
      </button>
      <button
        className="prbar-x"
        aria-label="Hide pull request bar"
        title="Hide until it changes"
        onClick={hide}
      >
        ×
      </button>
      {open && (
        <div className="prbar-menu" role="menu">
          <div className="prbar-menu-head">
            <b>{pr.title || `PR #${pr.number}`}</b>
            <span className="muted small">{ciTitle}</span>
          </div>
          {err && <div className="prbar-menu-err">{err}</div>}
          {!checks && !err && (
            <div className="muted small prbar-menu-empty">Loading checks…</div>
          )}
          {checks && checks.length === 0 && (
            <div className="muted small prbar-menu-empty">
              No checks on this pull request.
            </div>
          )}
          {checks && checks.length > 0 && (
            <ul className="prbar-checks">
              {[...checks]
                .sort(
                  (a, b) =>
                    ["fail", "pending", "pass"].indexOf(a.state) -
                    ["fail", "pending", "pass"].indexOf(b.state),
                )
                .map((c, i) => (
                  <li key={i} className={c.state}>
                    <span className="dot" />
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.name}
                      </a>
                    ) : (
                      <span>{c.name}</span>
                    )}
                    <span className="muted small">
                      {c.state === "pass"
                        ? "passed"
                        : c.state === "fail"
                          ? "failed"
                          : "running"}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <a
            className="prbar-menu-link"
            href={pr.url.replace(/\/?$/, "/checks")}
            target="_blank"
            rel="noreferrer"
          >
            Open checks on GitHub ↗
          </a>
        </div>
      )}
    </div>
  );
}
