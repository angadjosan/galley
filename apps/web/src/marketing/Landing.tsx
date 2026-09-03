import type { JSX, ReactNode } from 'react';
import { Mark } from '../chrome/icons.js';
import { SignInForm } from '../share/SignIn.js';
import type { Viewer } from '../api.js';
import './landing.css';

/**
 * The page a signed-out visitor lands on.
 *
 * Three rules, and the first one decides the other two:
 *
 * 1. **The reader is not an engineer.** PMs, ops leads, designers, founders —
 *    people who write documents and hand them to something. So the page argues
 *    in their vocabulary: a link, a comment, a suggestion, a doc that went
 *    stale. Block IDs, CommonMark and the CLI are real and they are load-
 *    bearing, but they are *mechanism*, and mechanism goes at the bottom under
 *    a heading that says who it is for.
 * 2. **Show the thing.** Every claim sits under a mock of the surface that
 *    makes it true. A landing page for an editor that shows no editor is asking
 *    to be trusted about the one thing the reader could have checked.
 * 3. **It is built from the app's own tokens**, not a marketing palette. Paper
 *    on a cool desk, pine for state, violet for work a human did not do. What
 *    somebody sees here is what they get after signing in, which is the only
 *    honest way to draw a screenshot.
 *
 * The mocks are hand-built markup rather than the real components: they have to
 * hold a fixed pose and stay legible at 380px wide, and a live editor does
 * neither. Their content is real — the file panel shows what the editor
 * actually writes, and the one terminal prints what `packages/cli` prints.
 */
export function Landing({
  notice,
  onSignedIn,
}: {
  /** Why you are looking at this rather than at your workspace. */
  notice?: string | null;
  onSignedIn(viewer: Viewer): void;
}): JSX.Element {
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="lp-brand" href="#top">
          <Mark />
          <span>Galley</span>
        </a>
        <nav className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#answers">Answers</a>
          <a href="#control">Control</a>
        </nav>
        <a className="lp-nav-cta" href="#start">
          Sign in
        </a>
      </header>

      <main id="top">
        <Hero notice={notice} onSignedIn={onSignedIn} />
        <HowItWorks />
        <Citations />
        <Review />
        <Control />
        <Staleness />
        <Portability />
        <ForEngineers />
        <Guardrails />
        <Closing />
      </main>

      <footer className="lp-foot">
        <div className="lp-brand lp-brand-quiet">
          <Mark />
          <span>Galley</span>
        </div>
        <p>Every document you write here is a plain text file you can open anywhere.</p>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ hero */

function Hero({
  notice,
  onSignedIn,
}: {
  notice?: string | null;
  onSignedIn(viewer: Viewer): void;
}): JSX.Element {
  return (
    <section className="lp-hero" id="start">
      <div className="lp-hero-copy">
        <p className="lp-eyebrow">For people who write documents</p>
        <h1>Write it like a doc. Hand it to any AI.</h1>
        <p className="lp-lede">
          Galley works the way your editor already works. Headings, tables, comments, a toolbar
          where you expect one. What it saves is a plain file that an assistant reads exactly as
          you wrote it, tables and all. Nothing to export, nothing to tidy up first.
        </p>

        <div className="lp-cta">
          {notice && (
            <p className="signin-notice" role="status" data-testid="signin-notice">
              {notice}
            </p>
          )}
          <SignInForm onSignedIn={onSignedIn} autoFocus={false} />
          <p className="lp-cta-note">
            Send anyone a link and they can read the doc, with no account to set up.
          </p>
        </div>
      </div>

      <div className="lp-hero-mock">
        <TwoAudiences />
      </div>
    </section>
  );
}

/**
 * The whole argument as one picture: the same document, twice.
 *
 * Left is the doc. Right is the file it saved while you typed, which is the
 * thing an assistant opens. There is no step between them, and the point is
 * that the reader can see there isn't.
 */
function TwoAudiences(): JSX.Element {
  return (
    <div className="lp-split">
      <figure className="lp-figure">
        <figcaption className="lp-figcap">What you write</figcaption>
        <Frame kind="app">
          <AppBar path="Specs / Checkout v2" />
          <div className="mk-page">
            <h2 className="mk-h1">Checkout v2</h2>
            <p className="mk-p">
              Every order goes through one <strong>authorization</strong> call before a card is
              charged. If it is declined the cart survives.
            </p>
            <h3 className="mk-h2">API fields</h3>
            <table className="mk-table">
              <tbody>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                </tr>
                <tr>
                  <td>amount</td>
                  <td>integer</td>
                  <td>yes</td>
                </tr>
                <tr>
                  <td>currency</td>
                  <td>string</td>
                  <td>no</td>
                </tr>
              </tbody>
            </table>
            <div className="mk-callout">
              <span className="mk-callout-label">Note</span>
              <p>Amounts are in cents. There are no decimals anywhere in this API.</p>
            </div>
          </div>
        </Frame>
      </figure>

      <figure className="lp-figure">
        <figcaption className="lp-figcap">What it saved while you typed</figcaption>
        <Frame kind="code">
          <FileBar name="checkout-v2.md" />
          <pre className="mk-code">
            <span className="c-line">
              <span className="c-h"># Checkout v2</span>
            </span>
            <span className="c-line" />
            <span className="c-line">Every order goes through one</span>
            <span className="c-line">**authorization** call before a</span>
            <span className="c-line">card is charged. If it is declined</span>
            <span className="c-line">the cart survives.</span>
            <span className="c-line" />
            <span className="c-line">
              <span className="c-h">## API fields</span>
            </span>
            <span className="c-line" />
            <span className="c-line">{'| Field    | Type    | Required |'}</span>
            <span className="c-line">{'| -------- | ------- | -------- |'}</span>
            <span className="c-line">{'| amount   | integer | yes      |'}</span>
            <span className="c-line">{'| currency | string  | no       |'}</span>
            <span className="c-line" />
            <span className="c-line">{'> [!NOTE]'}</span>
            <span className="c-line">{'> Amounts are in cents. There are'}</span>
            <span className="c-line">{'> no decimals anywhere in this API.'}</span>
          </pre>
        </Frame>
        <p className="lp-figfoot">
          One file, readable by a person and by a machine. Nobody types the asterisks.
        </p>
      </figure>
    </div>
  );
}

/* ---------------------------------------------------------- how it works */

function HowItWorks(): JSX.Element {
  return (
    <section className="lp-section" id="how">
      <SectionHead title="How it works" aside="Three steps · one document · no export" />
      <div className="lp-steps">
        <Step
          n="01"
          title="You write, the normal way"
          body="Bold, headings, tables, callouts, comments. If you can use Google Docs you can use this one, and you will never see a piece of formatting code."
        >
          <Frame kind="app">
            <MockToolbar />
            <div className="mk-page mk-page-sm">
              <h2 className="mk-h1">Refund policy</h2>
              <p className="mk-p">
                A refund goes back to the <strong>original payment method</strong> within five
                business days.
              </p>
              <p className="mk-p mk-anchored">
                Orders older than 90 days need a support approval first.
                <span className="mk-anchor-flag">1</span>
              </p>
            </div>
          </Frame>
        </Step>

        <Step
          n="02"
          title="You share it with an assistant"
          body="Send the link the way you would send it to a person. Whatever is reading it gets the whole document as you wrote it, and you choose whether it can only read or can also suggest."
        >
          <Frame kind="app">
            <div className="mk-panel-head">
              <span className="mk-panel-title mk-panel-title-plain">Share “Refund policy”</span>
            </div>
            <div className="mk-panel-body">
              <div className="mk-field">
                <span className="mk-field-label">Anyone with the link</span>
                <span className="mk-select">Can comment</span>
              </div>
              <label className="mk-toggle">
                <span className="mk-switch mk-switch-on" />
                <span>
                  Let AI assistants open it
                  <em>They come in as themselves, never as you.</em>
                </span>
              </label>
              <div className="mk-linkrow">
                <span className="mk-link">galley.app/l/9fK2wq</span>
                <span className="mk-btn mk-btn-sm mk-btn-primary">Copy</span>
              </div>
            </div>
          </Frame>
        </Step>

        <Step
          n="03"
          title="It proposes, you decide"
          body="An assistant that wants to change something leaves a suggestion on the exact paragraph, with a reason. You accept it, reject it, or write your own. Nothing lands on its own."
        >
          <Frame kind="app">
            <div className="mk-panel-head">
              <span className="mk-agent-dot" />
              <span className="mk-panel-title">Claude</span>
              <span className="mk-chip mk-chip-agent">Assistant</span>
            </div>
            <div className="mk-panel-body">
              <p className="mk-rationale">
                The 90-day cutoff became 60 days in the checkout code last Thursday.
              </p>
              <div className="mk-diff">
                <p className="mk-diff-row mk-removed">
                  Orders older than <s>90 days</s> need a support approval
                </p>
                <p className="mk-diff-row mk-added">
                  Orders older than <ins>60 days</ins> need a support approval
                </p>
              </div>
              <div className="mk-actions">
                <span className="mk-btn mk-btn-primary">Accept</span>
                <span className="mk-btn">Reject</span>
                <span className="mk-meta">Refund policy · ¶3</span>
              </div>
            </div>
          </Frame>
        </Step>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- citations */

function Citations(): JSX.Element {
  return (
    <section className="lp-section lp-section-alt" id="answers">
      <SectionHead title="Answers you can check" />
      <div className="lp-two">
        <div className="lp-two-copy">
          <p>
            When an assistant answers out of your documents, it can point at the sentence it used.
            Click the citation and you land on that paragraph, highlighted, in the doc it came
            from.
          </p>
          <p>
            That is the difference between an answer you have to take on faith and one you can go
            and read for yourself. It is also how you find out the doc was wrong.
          </p>
          <p className="lp-aside">
            Every paragraph keeps its own identity, so a citation still points at the right
            sentence after somebody rewrites the paragraph around it.
          </p>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <Frame kind="app">
              <div className="mk-panel-head">
                <span className="mk-agent-dot" />
                <span className="mk-panel-title">Support assistant</span>
              </div>
              <div className="mk-panel-body">
                <p className="mk-ask">Can I refund an order from four months ago?</p>
                <p className="mk-answer">
                  Not without a support approval. Anything past 60 days needs one before the refund
                  is queued.
                </p>
                <span className="mk-cite">Refund policy · ¶3</span>
              </div>
            </Frame>
          </figure>
          <figure className="lp-figure">
            <figcaption className="lp-figcap">Clicking the citation</figcaption>
            <Frame kind="app">
              <AppBar path="Policies / Refund policy" />
              <div className="mk-page mk-page-xs">
                <p className="mk-p">
                  A refund goes back to the original payment method within five business days.
                </p>
                <p className="mk-p mk-highlight">
                  Orders older than 60 days need a support approval first.
                </p>
                <p className="mk-p">
                  Partial refunds follow the same rule as full ones.
                </p>
              </div>
            </Frame>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- review */

function Review(): JSX.Element {
  return (
    <section className="lp-section">
      <SectionHead title="Edits arrive as suggestions" />
      <div className="lp-two lp-two-flip">
        <div className="lp-two-copy">
          <p>
            An assistant does not get to rewrite your document. It proposes, on the paragraphs it
            wants to change, and the proposal sits in a list until a person looks at it.
          </p>
          <p>
            If somebody edits that paragraph in the meantime, the proposal goes{' '}
            <strong>out of date</strong> and stays visible instead of quietly applying itself to
            text it was never written for.
          </p>
          <p className="lp-aside">
            Letting one assistant write straight into one document is a permission you can grant on
            purpose. It is never the default, and no rule you write can auto-accept on your behalf.
          </p>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <figcaption className="lp-figcap">Waiting on you</figcaption>
            <Frame kind="app">
              <div className="mk-list">
                <div className="mk-row">
                  <span className="mk-state mk-state-pending">New</span>
                  <div className="mk-row-main">
                    <p className="mk-row-title">Currency is required, not optional</p>
                    <p className="mk-row-sub">Claude · 2 paragraphs · 12 minutes ago</p>
                  </div>
                  <span className="mk-btn mk-btn-primary mk-btn-sm">Review</span>
                </div>
                <div className="mk-row">
                  <span className="mk-state mk-state-stale">Out of date</span>
                  <div className="mk-row-main">
                    <p className="mk-row-title">Rewrite the retry section</p>
                    <p className="mk-row-sub">Docs bot · Sam edited this paragraph since</p>
                  </div>
                  <span className="mk-btn mk-btn-sm">Show</span>
                </div>
                <div className="mk-row">
                  <span className="mk-state mk-state-done">Accepted</span>
                  <div className="mk-row-main">
                    <p className="mk-row-title">Fix the amount example</p>
                    <p className="mk-row-sub">Claude · accepted by Priya · yesterday</p>
                  </div>
                </div>
              </div>
            </Frame>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- control */

function Control(): JSX.Element {
  return (
    <section className="lp-section lp-section-alt" id="control">
      <SectionHead title="You decide what an assistant can touch" />
      <div className="lp-two">
        <div className="lp-two-copy">
          <p>
            An assistant asks for access by name, and you approve it in your own browser. It never
            borrows your account, and what it can do is always a smaller set than what you can do.
          </p>
          <ul className="lp-facts">
            <li>Read the handbook, suggest on the specs, write nowhere is a normal thing to set.</li>
            <li>Turn off a person&rsquo;s access and everything they approved stops working too.</li>
            <li>
              Every comment and every edit says which assistant made it and who approved that
              assistant.
            </li>
          </ul>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <Frame kind="app">
              <div className="mk-approve">
                <p className="mk-approve-lede">
                  <strong>Claude</strong> is asking for access to your workspace.
                </p>
                <ul className="mk-scopes">
                  <li>
                    <span className="mk-tick" /> Read documents you can read
                  </li>
                  <li>
                    <span className="mk-tick" /> Comment and suggest edits
                  </li>
                  <li>
                    <span className="mk-cross" /> Change a document directly
                  </li>
                  <li>
                    <span className="mk-cross" /> Invite anyone else
                  </li>
                </ul>
                <div className="mk-actions">
                  <span className="mk-btn mk-btn-primary">Approve</span>
                  <span className="mk-btn">Deny</span>
                </div>
                <p className="mk-approve-foot">
                  Approved by you, and it will say so on everything it does.
                </p>
              </div>
            </Frame>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- staleness */

function Staleness(): JSX.Element {
  return (
    <section className="lp-section">
      <SectionHead title="A wrong doc is worse than no doc" />
      <div className="lp-two lp-two-flip">
        <div className="lp-two-copy">
          <p>
            An out-of-date document used to sit there quietly. One that three assistants read every
            day turns a stale sentence into confident answers people act on.
          </p>
          <p>
            So Galley does not nag you about age. It tells you when something old is being read,
            and it tells the person whose document it is.
          </p>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <figcaption className="lp-figcap">Priya&rsquo;s Monday</figcaption>
            <Frame kind="app">
              <div className="mk-list">
                <div className="mk-row">
                  <span className="mk-flag mk-flag-warn" />
                  <div className="mk-row-main">
                    <p className="mk-row-title">Oncall runbook</p>
                    <p className="mk-row-sub">
                      Not touched in 7 months · 3 assistants read it this week
                    </p>
                  </div>
                  <span className="mk-btn mk-btn-sm">Open</span>
                </div>
                <div className="mk-row">
                  <span className="mk-flag mk-flag-agent" />
                  <div className="mk-row-main">
                    <p className="mk-row-title">Refund policy</p>
                    <p className="mk-row-sub">2 suggestions waiting since Thursday</p>
                  </div>
                  <span className="mk-btn mk-btn-sm">Review</span>
                </div>
                <div className="mk-row">
                  <span className="mk-flag" />
                  <div className="mk-row-main">
                    <p className="mk-row-title">Checkout v2</p>
                    <p className="mk-row-sub">
                      One comment lost its paragraph and is waiting to be reattached
                    </p>
                  </div>
                  <span className="mk-btn mk-btn-sm">Fix</span>
                </div>
              </div>
            </Frame>
            <p className="lp-figfoot">
              A comment that cannot be placed with confidence waits here with the text it was left
              on. Guessing at the wrong paragraph is worse than admitting it moved.
            </p>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ portability */

function Portability(): JSX.Element {
  return (
    <section className="lp-section lp-section-alt">
      <SectionHead title="The file stays yours" />
      <div className="lp-two">
        <div className="lp-two-copy">
          <p>
            Every document is an ordinary text file in a format that has been readable for twenty
            years. Download it, mail it, drop it in a folder your team already uses, open it in
            something else entirely. There is no export step because there is nothing to convert.
          </p>
          <p>
            And Galley leaves the rest of the file alone. Change one sentence and one sentence
            changes, which is the whole reason your engineers will let this near their repository.
          </p>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <figcaption className="lp-figcap">After an hour of editing one paragraph</figcaption>
            <Frame kind="code">
              <FileBar name="What actually changed" />
              <pre className="mk-code">
                <span className="c-line">{' A refund goes back to the original payment'}</span>
                <span className="c-line">{' method within five business days.'}</span>
                <span className="c-line" />
                <span className="c-line c-del">
                  − Orders older than 90 days need a support approval
                </span>
                <span className="c-line c-add">
                  + Orders older than 60 days need a support approval
                </span>
                <span className="c-line">{' first.'}</span>
                <span className="c-line" />
                <span className="c-line">{' Partial refunds follow the same rule.'}</span>
              </pre>
            </Frame>
            <p className="lp-figfoot">
              One line edited, one line changed. Nothing else in the file moved.
            </p>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- for the devs */

function ForEngineers(): JSX.Element {
  return (
    <section className="lp-section lp-section-tight">
      <SectionHead title="If your team has engineers" aside="They will ask, so: yes" />
      <div className="lp-two">
        <div className="lp-two-copy">
          <p>
            There is a command line tool. It mirrors a workspace into a folder, prints a document
            or a single paragraph to standard output, searches, comments, and proposes edits as
            scoped operations rather than a wholesale rewrite.
          </p>
          <p>
            That means the coding agents your team already runs can read your documents without
            anybody building an integration, and their proposals show up in the same review list as
            everyone else&rsquo;s.
          </p>
        </div>
        <div className="lp-two-mock">
          <figure className="lp-figure">
            <Frame kind="term">
              <TermBar title="zsh" />
              <pre className="mk-term">
                <Cmd>galley pull ./docs</Cmd>
                <Out>{`pulled 24 document(s) into docs`}</Out>
                <Cmd>galley search &quot;refund window&quot;</Cmd>
                <Out>{`policies/refunds#a1b2c3  § Refund policy
  Orders older than 60 days need a
  support approval first.`}</Out>
                <Cmd>{`galley read policies/refunds \\
  | claude -p "does the code match this?"`}</Cmd>
                <span className="mk-caret" />
              </pre>
            </Frame>
          </figure>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- guardrails */

function Guardrails(): JSX.Element {
  return (
    <section className="lp-section lp-section-tight">
      <SectionHead title="What keeps it from getting noisy" />
      <div className="lp-cards">
        <Card title="No comment floods">
          An assistant gets a fixed number of comments per document per run. Nineteen comments
          makes a document unreadable, so it is a limit rather than a setting.
        </Card>
        <Card title="Nothing auto-applies">
          Every suggestion waits for a person, including the ones that look obviously right and
          including the ones your own rules asked for.
        </Card>
        <Card title="Comments survive rewrites">
          A paragraph keeps its identity through an edit, so the thread you started on it is still
          there afterwards.
        </Card>
        <Card title="History without the jargon">
          Scrub back through the day, name a version you want to keep, and see who wrote a given
          sentence. No branches, no merges, nobody has to learn a new word.
        </Card>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- closing */

/**
 * The last word, and a way back to the one sign-in form on the page.
 *
 * It sends you up to the hero rather than repeating the form. Two live sign-in
 * forms on one page means two of every field and two of every button, which is
 * a worse thing for a screen reader and a password manager to walk into than a
 * scroll is for anybody else.
 */
function Closing(): JSX.Element {
  return (
    <section className="lp-closing">
      <h2>Open a document and hand it to something.</h2>
      <p>
        Write the way you already write. What you leave behind is a document your team can read and
        your assistants can use, without anybody exporting anything.
      </p>
      <a className="lp-closing-cta" href="#start">
        Get started
      </a>
    </section>
  );
}

/* -------------------------------------------------------------- primitives */

function SectionHead({ title, aside }: { title: string; aside?: string }): JSX.Element {
  return (
    <div className="lp-head">
      <h2>{title}</h2>
      {aside && <span className="lp-head-aside">{aside}</span>}
    </div>
  );
}

function Step({
  n,
  title,
  body,
  children,
}: {
  n: string;
  title: string;
  body: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <article className="lp-step">
      <div className="lp-step-mock">{children}</div>
      <h3>
        <span className="lp-step-n">{n}</span>
        {title}
      </h3>
      <p>{body}</p>
    </article>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <article className="lp-card">
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

/** A device around a mock: the app's paper, a file, or a terminal. */
function Frame({
  kind,
  children,
}: {
  kind: 'app' | 'term' | 'code';
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`mk mk-dev-${kind}`} aria-hidden="true">
      {children}
    </div>
  );
}

function AppBar({ path }: { path: string }): JSX.Element {
  return (
    <div className="mk-bar">
      <Mark />
      <span className="mk-path">{path}</span>
      <span className="mk-presence">
        <span className="mk-avatar">P</span>
        <span className="mk-avatar mk-avatar-agent">C</span>
      </span>
    </div>
  );
}

function FileBar({ name }: { name: string }): JSX.Element {
  return (
    <div className="mk-filebar">
      <span className="mk-filename">{name}</span>
    </div>
  );
}

function TermBar({ title }: { title: string }): JSX.Element {
  return (
    <div className="mk-termbar">
      <span className="mk-dot" />
      <span className="mk-dot" />
      <span className="mk-dot" />
      <span className="mk-termtitle">{title}</span>
    </div>
  );
}

function Cmd({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="mk-cmd">
      <span className="mk-prompt">$</span>
      {children}
    </span>
  );
}

function Out({ children }: { children: ReactNode }): JSX.Element {
  return <span className="mk-out">{children}</span>;
}

function MockToolbar(): JSX.Element {
  return (
    <div className="mk-toolbar">
      <span className="mk-tb-item mk-tb-wide">Body text</span>
      <span className="mk-tb-sep" />
      <span className="mk-tb-item mk-tb-b">B</span>
      <span className="mk-tb-item mk-tb-i">I</span>
      <span className="mk-tb-item">U</span>
      <span className="mk-tb-sep" />
      <span className="mk-tb-item">&#9776;</span>
      <span className="mk-tb-item">&#8801;</span>
      <span className="mk-tb-sep" />
      <span className="mk-tb-item mk-tb-on">&#8220;</span>
    </div>
  );
}
