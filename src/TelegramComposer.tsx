/**
 * Telegram composer — target-agnostic.
 *
 * The composer only knows about a "target" whose current Telegram state
 * looks the same for every kind of publishable item (incident updates,
 * maintenance rows, etc.):
 *
 *   { html, button, message_id, sent_at, edited_at }
 *
 * The parent supplies a `generateDraft()` that produces the initial HTML
 * for a fresh compose, and three async handlers (save / send / edit).
 * The composer does the rich-text editing, preview, character count,
 * button editor, and error handling.
 *
 * All Telegram Bot API traffic runs through the Worker; this component
 * only ever sees the composed HTML + the returned message_id.
 */

import React from "react";
import {
  Bold, Italic, Underline, Strikethrough, Link as LinkIcon, Code, FileCode2,
  Quote, EyeOff, List, ListOrdered, Send, Save, Loader2, Trash2,
} from "lucide-react";
import type { TelegramButton } from "./api";

export type TelegramTarget = {
  /** Stable key for React and for effect deps. */
  key: string;
  /** Called on Reset — must return Telegram-compatible HTML. */
  generateDraft: () => string;
  /** Current stored state for this target. */
  existing: {
    html: string | null;
    message_id: number | null;
    sent_at: number | null;
    edited_at: number | null;
    button_text: string | null;
    button_url: string | null;
  };
  save: (html: string, button: TelegramButton) => Promise<unknown>;
  send: (html: string, button: TelegramButton) => Promise<unknown>;
  edit: (html: string, button: TelegramButton) => Promise<unknown>;
};

type Props = {
  target: TelegramTarget;
  /** Default URL for the auto-populated "View status" button on fresh drafts. */
  statusUrl: string;
  onChanged: () => Promise<void> | void;
  notify: (m: string) => void;
};

// ---------------------------------------------------------------------------
// Shared helpers (also re-exported so callers can build their own drafts).
// ---------------------------------------------------------------------------

export function escHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export function parseAffected(raw: unknown): string[] {
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
      if (!/^(https?:|tg:|mailto:)/i.test(href)) return kids();
      return `<a href="${escHtml(href)}">${kids()}</a>`;
    }
    case "code":
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
  return out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Preview: render Telegram HTML back into safe DOM using the same whitelist.
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

export function TelegramComposer({ target, statusUrl, onChanged, notify }: Props) {
  const editorRef = React.useRef<HTMLDivElement>(null);
  const alreadySent = target.existing.message_id != null;

  const initial = React.useMemo(() => {
    if (target.existing.html && target.existing.html.trim()) return target.existing.html;
    return target.generateDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.key]);

  const [html, setHtml] = React.useState<string>(initial);
  const [busy, setBusy] = React.useState<"send" | "edit" | "save" | null>(null);
  const [error, setError] = React.useState<string>("");
  const [dirty, setDirty] = React.useState(false);

  const initialButtonText =
    target.existing.button_text ?? (alreadySent ? "" : "View status");
  const initialButtonUrl =
    target.existing.button_url ?? (alreadySent ? "" : statusUrl);
  const [buttonText, setButtonText] = React.useState<string>(initialButtonText);
  const [buttonUrl, setButtonUrl]   = React.useState<string>(initialButtonUrl);

  const buttonPayload = React.useMemo<TelegramButton>(() => ({
    telegram_button_text: buttonText.trim() ? buttonText.trim() : null,
    telegram_button_url:  buttonUrl.trim()  ? buttonUrl.trim()  : null,
  }), [buttonText, buttonUrl]);
  const buttonInvalid =
    (buttonText.trim() && !buttonUrl.trim()) ||
    (buttonUrl.trim() && !buttonText.trim()) ||
    (buttonUrl.trim() && !/^(https?:\/\/|tg:\/\/)/i.test(buttonUrl.trim()));

  // Seed the contentEditable once from the initial HTML.
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
    exec("createLink", url);
  }

  async function onSaveDraft() {
    setBusy("save"); setError("");
    try {
      await target.save(html, buttonPayload);
      setDirty(false);
      notify("Telegram draft saved");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to save draft.");
    } finally { setBusy(null); }
  }

  async function onSend() {
    setBusy("send"); setError("");
    try {
      await target.send(html, buttonPayload);
      setDirty(false);
      notify("Sent to Telegram");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to send.");
    } finally { setBusy(null); }
  }

  async function onEdit() {
    setBusy("edit"); setError("");
    try {
      await target.edit(html, buttonPayload);
      setDirty(false);
      notify("Telegram message updated");
      await onChanged();
    } catch (e: any) {
      setError(e?.message ?? "Failed to edit.");
    } finally { setBusy(null); }
  }

  const length = html.length;
  const overLimit = length > 4096;

  return (
    <div className="tg-composer">
      <div className="tg-composer-head">
        <span className="tg-label">Telegram message</span>
        <TelegramStatus existing={target.existing} />
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
            const draft = target.generateDraft();
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
            onChange={(e) => { setButtonText(e.target.value); setDirty(true); }}
            aria-label="Inline button label"
          />
          <input
            className="tg-button-input"
            type="url"
            placeholder="https://…"
            value={buttonUrl}
            onChange={(e) => { setButtonUrl(e.target.value); setDirty(true); }}
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TelegramStatus({ existing }: { existing: TelegramTarget["existing"] }) {
  if (existing.message_id == null) {
    return <span className="tg-badge tg-badge-off">○ Not sent</span>;
  }
  const sent = existing.sent_at ? new Date(existing.sent_at * 1000) : null;
  const edited = existing.edited_at ? new Date(existing.edited_at * 1000) : null;
  const fmt = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <span className="tg-badge tg-badge-on">
      ✓ Sent{sent ? ` at ${fmt(sent)}` : ""}{edited ? ` · edited ${fmt(edited)}` : ""}
    </span>
  );
}
