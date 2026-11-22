import type { KeyboardEvent, ReactNode, Ref } from "react";

export interface PaneProps {
  /** Accessible name for the pane, e.g. "Editing ~/notes.txt". */
  label: string;
  /** Main title text (the file's display path). */
  title: string;
  /** Full path for the title's tooltip. */
  titleTooltip?: string;
  /** Shown right after the title (e.g. an unsaved-changes dot). */
  titleExtra?: ReactNode;
  /** Shown between the title and the actions (prompts, notices, details). */
  middle?: ReactNode;
  /** Buttons placed before the close button. */
  actions?: ReactNode;
  onClose(): void;
  onKeyDown?(e: KeyboardEvent<HTMLElement>): void;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * The top area used by `mon` and `preview`: a title bar with a close button over a body.
 * The terminal sits below it (see .workspace in index.css).
 */
export function Pane({ label, title, titleTooltip, titleExtra, middle, actions, onClose, onKeyDown, ref, children }: PaneProps) {
  return (
    <section className="pane" aria-label={label} onKeyDown={onKeyDown} ref={ref} tabIndex={-1}>
      <header className="pane-titlebar">
        <span className="pane-title" title={titleTooltip ?? title}>
          <span className="pane-title-text">{title}</span>
          {titleExtra}
        </span>
        {middle}
        <span className="pane-actions">
          {actions}
          <button type="button" className="pane-close" onClick={onClose} aria-label="Close" title="Close">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}
