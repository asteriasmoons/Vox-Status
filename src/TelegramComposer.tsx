/**
 * Telegram composer — lives inside the incident update editor.
 *
 * Purpose-built rich-text composer that produces Telegram-compatible HTML
 * (parse_mode: "HTML"). Each incident update owns its own Telegram message
 * so that a single incident can produce a sequence of independently-editable
 * Telegram posts as it progresses (Investigating → Identified → Monitoring
 * → Resolved).
 *
 * All Telegram Bot API traffic runs through the Worker; this component only
 * ever sees the composed HTML + the returned message_id.
 */

import React from "react";
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Code, FileCode2,
  Quote, EyeOff, List, ListOrdered, Send, Save, Loader2, Trash2,
} from "lucide-react";
import * as api from "./api";
import type { IncidentRow, IncidentUpdateRow } from "./api";

type Props = {
  incident: IncidentRow;
  update: IncidentUpdateRow;
  statusUrl: string;
  onChanged: () => Promise<void> | void;
  notify: (m: string) => void;
};

// ---------------------------------------------------------------------------
// Draft generation. Uses the incident/update to build a sensible starting
// point; the user then edits it in the toolbar before sending.
// ---------------------------------------------------------------------------

const STATE_META: Record<
  string,
  { emoji: string; label: string; blurb: (svc: string) => string }
> = {
  investigating: {
    emoji: "🔴",
    label: "Investigating",
    blurb: (svc) => `We're investigating an issue affecting ${svc}.`,
  },
  identified: {
    emoji: "🟠",
    label: "Identified",
    blurb: (svc) => `We've identified the cause of the current issue with ${svc} and are working on a fix.`,
  },
  monitoring: {
    emoji: "🟡",
    label: "Monitoring",
    blurb: (svc) => `A fix has been deployed for the ${svc} issue and we're monitoring recovery.`,
  },
  resolved: {
    emoji: "🟢",
    label: "Resolved",
    blurb: (svc) => `The ${svc} issue has been resolved and service is operating normally.`,
  },
};

function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function generateDraft(incident: IncidentRow, update: IncidentUpdateRow): string {
  // Prefer the update's label (Investigating / Identified / Monitoring /
  // Resolved) — it's what actually describes this specific update. Fall
  // back to the incident's overall state.
  const key = (update.label || incident.state || "investigating").toLowerCase().trim();
  const meta = STATE_META[key] ?? STATE_META[incident.state] ?? STATE_META.investigating;
  const affected = parseAffected(incident.affected);
  const service = affected[0] ?? "Vox";
  const body = (update.message ?? "").trim() || meta.blurb(service);
  // No inline "View status →" link — the CTA lives in the inline-keyboard
  // button below the message (see the Button editor in the composer).
  return (
    `${meta.emoji} <b>${escHtml(service)} — ${escHtml(meta.label)}</b>\n` +
    `${escHtml(body)}`
  );
}

function parseAffected(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// contentEditable → Telegram HTML serializer.
//
// Telegram's HTML parse mode accepts a small whitelist: b/strong, i/em,
// u/ins, s/strike/del, a[href], code, pre, blockquote, and tg-spoiler.
// It does NOT accept ul/ol/li — those are serialized to plain-text
// bullets/numbers with line breaks. Everything else is stripped.
// ---------------------------------------------------------------------------

function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escHtml(node.textContent ?? "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const kids = () => Array.from(el.childNodes).map(serialize).join("");

  switch (tag) {
    case "br":
      return "\n";
    case "p":
    case "div": {
      const inner = kids();
      // Treat block containers as line separators. Trim trailing newline
      // spam so multiple wrapped divs don't blow up spacing.
      return inner + (inner.endsWith("\n") ? "" : "\n");
    }
    case "b":
    case "strong":
      return `<b>${kids()}</b>`;
    case "i":
    case "em":
      return `<i>${kids()}</i>`;
    case "u":
    case "ins":
      return `<u>${kids()}</u>`;
    case "s":
    case "strike":
    case "del":
      return `<s>${kids()}</s>`;
    case "a": {
      const href = (el.getAttribute("href") ?? "").trim();
      // Only allow http(s) and tg: links to avoid javascript: injection.
      if (!/^(https?:|tg:|mailto:)/i.test(href)) return kids();
      return `<a href="${escHtml(href)}">${kids()}</a>`;
    }
    case "code":
      // If inside <pre>, the outer <pre> handler will wrap; otherwise inline.
      if (el.parentElement && el.parentElement.tagName === "PRE") return kids();
      return `<code>${kids()}</code>`;
    case "pre":
      return `<pre>${kids()}</pre>`;
    case "blockquote":
      return `<blockquote>${kids()}</blockquote>`;
    case "tg-spoiler":
      return `<tg-spoiler>${kids()}</tg-spoiler>`;
    case "span": {
      if (el.classList.contains("tg-spoiler")) return `<tg-spoiler>${kids()}</tg-spoiler>`;
      return kids();
    }
    case "ul": {
      const items = Array.from(el.children).filter((c) => c.tagName === "LI");
      return items.map((li) => `• ${serialize(li).trim()}`).join("\n") + "\n";
    }
    case "ol": {
      const items = Array.from(el.children).filter((c) => c.tagName === "LI");
      return items.map((li, i) => `${i + 1}. ${serialize(li).trim()}`).join("\n") + "\n";
    }
    case "li":
      return kids();
    default:
      return kids();
  }
}

function editorToTelegramHtml(root: HTMLElement): string {
  const out = Array.from(root.childNodes).map(serialize).join("");
  // Collapse >2 blank lines and trim trailing whitespace.
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Preview: render Telegram HTML back into safe DOM using the same whitelist.
// This is a manual parser rather than dangerouslySetInnerHTML so we never
// render an unexpected tag or attribute.
// ---------------------------------------------------------------------------

function renderPreview(html: string): React.ReactNode {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild as HTMLElement | null;
  if (!root) return null;
  return renderNodes(root.childNodes, 0);
}

function renderNodes(nodes: NodeListOf<ChildNode> | ChildNode[], keyBase: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  nodes.forEach((n, i) => {
    const key = `${keyBase}-${i}`;
    if (n.nodeType === Node.TEXT_NODE) {
      // Split on newlines so \n renders as <br>.
      const text = n.textContent ?? "";
      const parts = text.split("\n");
      parts.forEach((p, j) => {
        if (p) out.push(<React.Fragment key={`${key}-t${j}`}>{p}</React.Fragment>);
        if (j < parts.length - 1) out.push(<br key={`${key}-br${j}`} />);
      });
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const kids = renderNodes(el.childNodes, i);
    switch (tag) {
      case "b": case "strong": out.push(<strong key={key}>{kids}</strong>); break;
      case "i": case "em":     out.push(<em key={key}>{kids}</em>); break;
      case "u": case "ins":    out.push(<u key={key}>{kids}</u>); break;
      case "s": case "strike": case "del": out.push(<s key={key}>{kids}</s>); break;
      case "a": {
        const href = el.getAttribute("href") ?? "#";
        out.push(<a key={key} href={href} target="_blank" rel="noreferrer noopener">{kids}</a>);
        break;
      }
      case "code": out.push(<code key={key}>{kids}</code>); break;
      case "pre":  out.push(<pre key={key}>{kids}</pre>); break;
      case "blockquote": out.push(<blockquote key={key}>{kids}</blockquote>); break;
      case "tg-spoiler":
        out.push(<span key={key} className="tg-spoiler">{kids}</span>);
        break;
      default: out.push(<React.Fragment key={key}>{kids}</React.Fragment>);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function TelegramComposer({ incident, update, statusUrl, onChanged, notify }: Props) {
  const editorRef = React.useRef<HTMLDivElement>(null);
  const alreadySent = update.telegram_message_id != null;

  // The composed Telegram HTML (as returned by serialize). Kept as state so
  // the preview and character count update live.
  const initial = React.useMemo(() => {
    if (update.telegram_html && update.telegram_html.trim()) return update.telegram_html;
    return generateDraft(incident, update);
  }, [incident, update]);
  const [html, setHtml] = React.useState<string>(initial);
  const [busy, setBusy] = React.useState<"send" | "edit" | "save" | null>(null);
  const [error, setError] = React.useState<string>("");
  const [dirty, setDirty] = React.useState(false);

  // Inline-keyboard button. Defaults to a "View status" button pointed at
  // the status page — the user can rename it, change the URL, or clear both
  // fields to send the message with no button attached.
  const initialButtonText = update.telegram_button_text
    ?? (update.telegram_message_id == null ? "View status" : "");
  const initialButtonUrl = update.telegram_button_url
    ?? (update.telegram_message_id == null ? statusUrl : "");
  const [buttonText, setButtonText] = React.useState<string>(initialButtonText);
  const [buttonUrl, setButtonUrl]   = React.useState<string>(initialButtonUrl);
  const buttonPayload = React.useMemo(() => ({
    telegram_button_text: buttonText.trim() ? buttonText.trim() : null,
    telegram_button_url:  buttonUrl.trim()  ? buttonUrl.trim()  : null,
  }), [buttonText, buttonUrl]);
  const buttonInvalid =
    (buttonText.trim() && !buttonUrl.trim()) ||
    (buttonUrl.trim() && !buttonText.trim()) ||
    (buttonUrl.trim() && !/^(https?:\/\/|tg:\/\/)/i.test(buttonUrl.trim()));

  function onButtonChange(next: { text?: string; url?: string }) {
    if (next.text !== undefined) setButtonText(next.text);
    if (next.url  !== undefined) setButtonUrl(next.url);
    setDirty(true);
  }

  // Seed the contentEditable once from the initial HTML (which is Telegram
  // HTML — the tag whitelist is a subset of what the browser will render).
  React.useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML === "") {
      editorRef.current.innerHTML = initial;
      setHtml(initial);
    }
  }, [initial]);

  function onEditorInput() {
    if (!editorRef.current) return;
    const next = editorToTelegramHtml(editorRef.current);
    setHtml(next);
    setDirty(true);
  }

  function exec(cmd: string, value?: string) {
    // execCommand is deprecated but still the most reliable way to apply
    // inline formatting to a selection inside contentEditable across
    // browsers. We only use it for the basic inline styles.
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(cmd, false, value);
    onEditorInput();
    editorRef.current?.focus();
  }

  function wrapSelection(tagName: string, attrs: Record<string, string> = {}) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !editorRef.current) return;
    const range = sel.getRangeAt(0);
    if (!editorRef.current.contains(range.commonAncestorContainer)) return;
    const wrapper = document.createElement(tagName);
    for (const [k, v] of Object.entries(attrs)) wrapper.setAttribute(k, v);
    const contents = range.extractContents();
    if (contents.childNodes.length === 0) {
      wrapper.appendChild(document.createTextNode(sel.toString() || " "));
    } else {
      wrapper.appendChild(contents);
    }
    range.insertNode(wrapper);
    // Reselect the wrapped content.
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(newRange);
    onEditorInput();
    editorRef.current.focus();
  }

  function insertList(ordered: boolean) {
    exec(ordered ? "insertOrderedList" : "insertUnorderedList");
  }

  function insertLink() {
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    if (!/^(https?:|tg:|mailto:)/i.test(url)) {
      setError("Links must start with http(s):, mailto:, or tg:");
      return;
    }
    setError("");
    // Use execCommand so it handles the current selection (or inserts anchor
    // at the cursor if nothing is selected).
    exec("createLink", url);
  }

  async function onSaveDraft() {
    setBusy("save"); setError("");
    try {
      await api.saveTelegramDraft(incident.id, update.id, html, buttonPayload);
      setDirty(false);
      notify("Telegram draft saved");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to save draft.");
    } finally {
      setBusy(null);
    }
  }

  async function onSend() {
    setBusy("send"); setError("");
    try {
      await api.sendTelegramUpdate(incident.id, update.id, html, buttonPayload);
      setDirty(false);
      notify("Sent to Telegram");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to send.");
    } finally {
      setBusy(null);
    }
  }

  async function onEdit() {
    setBusy("edit"); setError("");
    try {
      await api.editTelegramUpdate(incident.id, update.id, html, buttonPayload);
      setDirty(false);
      notify("Telegram message updated");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to edit.");
    } finally {
      setBusy(null);
    }
  }

  const length = html.length;
  const overLimit = length > 4096;

  return (
    <div className="tg-composer">
      <div className="tg-composer-head">
        <span className="tg-label">Telegram message</span>
        <TelegramStatus update={update} />
      </div>

      <div className="tg-toolbar" role="toolbar" aria-label="Telegram formatting">
        <TbBtn title="Bold"          onClick={() => exec("bold")}><Bold size={14} /></TbBtn>
        <TbBtn title="Italic"        onClick={() => exec("italic")}><Italic size={14} /></TbBtn>
        <TbBtn title="Underline"     onClick={() => exec("underline")}><Underline size={14} /></TbBtn>
        <TbBtn title="Strikethrough" onClick={() => exec("strikeThrough")}><Strikethrough size={14} /></TbBtn>
        <span className="tg-sep" />
        <TbBtn title="Link"          onClick={insertLink}><LinkIcon size={14} /></TbBtn>
        <TbBtn title="Inline code"   onClick={() => wrapSelection("code")}><Code size={14} /></TbBtn>
        <TbBtn title="Code block"    onClick={() => wrapSelection("pre")}><FileCode2 size={14} /></TbBtn>
        <TbBtn title="Blockquote"    onClick={() => wrapSelection("blockquote")}><Quote size={14} /></TbBtn>
        <TbBtn title="Spoiler"       onClick={() => wrapSelection("tg-spoiler")}><EyeOff size={14} /></TbBtn>
        <span className="tg-sep" />
        <TbBtn title="Bulleted list" onClick={() => insertList(false)}><List size={14} /></TbBtn>
        <TbBtn title="Numbered list" onClick={() => insertList(true)}><ListOrdered size={14} /></TbBtn>
        <span className="tg-sep" />
        <button
          type="button"
          className="tg-tool tg-tool-text"
          title="Reset to generated draft"
          onClick={() => {
            const draft = generateDraft(incident, update);
            if (editorRef.current) editorRef.current.innerHTML = draft;
            setHtml(draft);
            setButtonText("View status");
            setButtonUrl(statusUrl);
            setDirty(true);
          }}
        >
          <Trash2 size={13} /> Reset
        </button>
      </div>

      <div
        ref={editorRef}
        className="tg-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={onEditorInput}
        onBlur={onEditorInput}
        spellCheck
        aria-label="Telegram message body"
      />

      <div className="tg-button-editor">
        <span className="tg-preview-label">Inline button (optional)</span>
        <div className="tg-button-row">
          <input
            className="tg-button-input"
            type="text"
            placeholder="Button label — e.g. View status"
            value={buttonText}
            onChange={(e) => onButtonChange({ text: e.target.value })}
            aria-label="Inline button label"
          />
          <input
            className="tg-button-input"
            type="url"
            placeholder="https://…"
            value={buttonUrl}
            onChange={(e) => onButtonChange({ url: e.target.value })}
            aria-label="Inline button URL"
          />
          <button
            type="button"
            className="dash-btn ghost tg-button-clear"
            onClick={() => { setButtonText(""); setButtonUrl(""); setDirty(true); }}
            title="Send without a button"
          >
            Clear
          </button>
        </div>
        {buttonInvalid && (
          <div className="tg-button-hint">
            Provide both a label and an <code>https://</code> URL, or clear both to send without a button.
          </div>
        )}
      </div>

      <div className="tg-preview">
        <span className="tg-preview-label">Preview</span>
        <div className="tg-preview-bubble">
          {renderPreview(html)}
          {buttonPayload.telegram_button_text && buttonPayload.telegram_button_url && !buttonInvalid && (
            <a
              className="tg-preview-button"
              href={buttonPayload.telegram_button_url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {buttonPayload.telegram_button_text}
            </a>
          )}
        </div>
      </div>

      <div className="tg-composer-foot">
        <span className={`tg-count ${overLimit ? "over" : ""}`}>{length}/4096</span>
        <div className="tg-actions">
          {alreadySent ? (
            <>
              <button
                type="button"
                className="dash-btn ghost"
                onClick={onSaveDraft}
                disabled={busy !== null || !dirty}
                title="Save the composed content without changing the Telegram post"
              >
                {busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save draft
              </button>
              <button
                type="button"
                className="dash-btn primary"
                onClick={onEdit}
                disabled={busy !== null || overLimit || !html.trim() || Boolean(buttonInvalid)}
              >
                {busy === "edit" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save Telegram edit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="dash-btn ghost"
                onClick={onSaveDraft}
                disabled={busy !== null || !dirty}
              >
                {busy === "save" ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save draft
              </button>
              <button
                type="button"
                className="dash-btn primary"
                onClick={onSend}
                disabled={busy !== null || overLimit || !html.trim() || Boolean(buttonInvalid)}
              >
                {busy === "send" ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Send to Telegram
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="dash-error tg-error">{error}</div>}
    </div>
  );
}

function TbBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="tg-tool"
      title={title}
      aria-label={title}
      // Prevent the button from stealing focus and collapsing the current
      // selection inside the contentEditable before the command runs.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TelegramStatus({ update }: { update: IncidentUpdateRow }) {
  if (update.telegram_message_id == null) {
    return <span className="tg-badge tg-badge-off">○ Not sent</span>;
  }
  const sent = update.telegram_sent_at ? new Date(update.telegram_sent_at * 1000) : null;
  const edited = update.telegram_edited_at ? new Date(update.telegram_edited_at * 1000) : null;
  const fmt = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <span className="tg-badge tg-badge-on">
      ✓ Sent{sent ? ` at ${fmt(sent)}` : ""}{edited ? ` · edited ${fmt(edited)}` : ""}
    </span>
  );
}
