// confirm / dispute an entry through POST /v1/feedback. The id is checked against the base first: a merged entry
// points to the one that carries it, a withdrawn one is not reported on, an unknown id is refused before sending.

import { ErrataClient, FeedbackPayload } from "./client.js";
import { inactiveById } from "./assess.js";

export const ID_RE = /^(pypi|npm)\/([A-Za-z0-9@._/-]{1,100})\/([A-Za-z0-9.+!_-]{1,64})\/(\d{4})$/;
export const MAX_NOTE = 500;          // config/errata.yaml feedback.max_note

export type ReportVerdict = "confirm" | "dispute";

export interface ReportPlan {
  ok: boolean;
  status: "ready" | "invalid" | "merged" | "withdrawn" | "unknown_entry";
  message: string;
  payload?: FeedbackPayload;
  target?: string | null;
}

/** Build and check the report without sending it (the CLI shows this and asks before sending). */
export async function planReport(client: ErrataClient, id: string, verdict: string, note = "", model = ""): Promise<ReportPlan> {
  const m = ID_RE.exec(id || "");
  if (!m) return { ok: false, status: "invalid", message: "id must look like pypi/<package>/<version>/0001" };
  if (verdict !== "confirm" && verdict !== "dispute") return { ok: false, status: "invalid", message: "verdict must be confirm or dispute" };
  if (note.length > MAX_NOTE) return { ok: false, status: "invalid", message: `note longer than ${MAX_NOTE} characters` };
  const events = await client.changelog();
  const gone = inactiveById(id, events);
  if (gone?.status === "merged") {
    return { ok: false, status: "merged", target: gone.target,
      message: `${id} was merged into ${gone.target}; report on ${gone.target} instead` };
  }
  if (gone?.status === "withdrawn") {
    return { ok: false, status: "withdrawn", message: `${id} was withdrawn (${gone.reason || "no reason recorded"}); nothing to report on` };
  }
  const doc = await client.package(m[1], m[2]);
  if (!doc || !doc.errata.some((e) => e.id === id)) {
    return { ok: false, status: "unknown_entry", message: `${id} is not an entry of the base` };
  }
  const payload: FeedbackPayload = { kind: verdict, errata_id: id, outcome: verdict === "confirm" ? "worked" : "failed" };
  if (note) payload.note = note;
  if (model) payload.model = model;
  return { ok: true, status: "ready", message: `${verdict} ${id} → ${client.feedbackUrl}`, payload };
}

export interface ReportResult { sent: boolean; status: string; message: string; receipt?: string; http?: number }

export async function sendReport(client: ErrataClient, plan: ReportPlan): Promise<ReportResult> {
  if (!plan.ok || !plan.payload) return { sent: false, status: plan.status, message: plan.message };
  const r = await client.feedback(plan.payload);
  if (r.status === "received") {
    return { sent: true, status: "received", receipt: r.id, http: r.http,
      message: `received as ${r.id}; queued for a sandbox check, not published as is` };
  }
  return { sent: false, status: "rejected", http: r.http, message: r.error || `HTTP ${r.http}` };
}
