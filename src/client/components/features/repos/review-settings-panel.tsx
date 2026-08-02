import { useEffect, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { Switch } from '@client/components/ui/switch';
import { Input } from '@client/components/ui/input';
import { Button } from '@client/components/ui/button';
import { Select } from '@client/components/ui/select';
import { cn } from '@client/lib/utils';
import {
  reviewCategories,
  reviewSeverities,
  reviewConfigSchema,
  type RepoConfig,
  type RepoConfigRecord,
  type ReviewCategory,
  type ReviewSeverity,
} from '@shared/schema';
import {
  buildCategoryConfidence,
  categoryConfidenceEqual,
  categoryConfidenceValid,
  categoryConfidenceValueValid,
  stringSetEqual,
  type ReviewSettingsDraft,
} from '@client/lib/review-config-draft';

type ReviewConfig = RepoConfig['review'];
type ReviewOn = ReviewConfig['on'][number];

// The 5 PR webhook events the engine reviews on (schema.ts:111). `on` is a SET —
// order is irrelevant and dirty tracking uses stringSetEqual, not array-index equality.
const REVIEW_EVENTS: { value: ReviewOn; label: string }[] = [
  { value: 'opened', label: 'PR opened' },
  { value: 'synchronize', label: 'New commits pushed' },
  { value: 'ready_for_review', label: 'Marked ready for review' },
  { value: 'reopened', label: 'PR reopened' },
  { value: 'closed', label: 'PR closed' },
];

// Parse a numeric-input string, returning NaN for empty/whitespace so an empty field
// fails reviewConfigSchema.safeParse (valid:false) instead of coercing to 0 (Number('') === 0).
function parseNum(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return Number.NaN;
  return Number(trimmed);
}

// Order-sensitive list equality for the skip_files / custom_rules add-remove editors,
// which preserve insertion order (unlike the order-insensitive on/focus sets).
function orderedListEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// IN-02: per-field bound check for a numeric input. A field is valid only when its
// parsed value is finite and within the documented [min,max]. Empty (parseNum → NaN)
// counts as invalid so the inline hint stays consistent with the form-level `valid`
// gate (an empty numeric field already fails reviewConfigSchema and blocks Apply).
function numFieldValid(raw: string, min: number, max: number): boolean {
  const n = parseNum(raw);
  return Number.isFinite(n) && n >= min && n <= max;
}

interface NumberFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  className?: string;
}

// IN-02: numeric field with per-field inline validation feedback, mirroring the
// mention_trigger pattern (aria-invalid + a short destructive hint) so a user faced with
// a greyed-out Apply can see exactly which field is out of its documented bound.
function NumberField({ label, value, onChange, min, max, step, ariaLabel, className }: NumberFieldProps) {
  const valid = numFieldValid(value, min, max);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        aria-invalid={!valid}
        className={className}
      />
      {!valid && (
        <span className="text-xs text-destructive">
          Enter a value between {min} and {max}.
        </span>
      )}
    </label>
  );
}

function toggleValue<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

interface ListEditorProps {
  title: string;
  hint: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addAriaLabel: string;
  emptyHint: string;
}

// Add/remove list editor, cloned from the allowed-account-IDs pattern (repos.tsx:290-404):
// trimmed + deduped, Enter-to-add, empty-state affordance, <ul> of pill rows with a ghost X.
function ListEditor({ title, hint, items, onChange, placeholder, addAriaLabel, emptyHint }: ListEditorProps) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed || items.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...items, trimmed]);
    setDraft('');
  };

  const remove = (value: string) => onChange(items.filter((entry) => entry !== value));

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={addAriaLabel}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} className="gap-1.5">
          <Plus size={13} />
          Add
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((value) => (
            <li
              key={value}
              className="flex items-center justify-between gap-2 rounded border border-border/60 bg-card px-2.5 py-1.5"
            >
              <span className="min-w-0 break-all font-mono text-xs text-foreground">{value}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(value)}
                aria-label={`Remove ${value}`}
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}

// Shared label + Switch row (repos.tsx:313-325 idiom).
function ToggleRow({ label, description, checked, onCheckedChange, ariaLabel }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={ariaLabel} />
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

interface ReviewSettingsPanelProps {
  repo: RepoConfigRecord;
  onChange: (draft: ReviewSettingsDraft) => void;
}

/**
 * UI-01 Review Settings editor. Controlled sub-editor cloned from InteractivePanel
 * (repos.tsx:236-436): seeds from repo.parsedJson.review, reports a full ReviewSettingsDraft
 * up to the modal, and has NO local save button — the modal's single Apply persists it.
 *
 * The assembled draft.review is built by IMMUTABLE NESTED SPREADS from the FULL current review
 * (REVIEW #5) so the deliberately-unexposed knobs passes.critic.skip_threshold,
 * passes.critic.input_char_budget, and passes.ensemble.temperature (plus exec/labels — D-03)
 * survive a save byte-for-byte.
 */
export function ReviewSettingsPanel({ repo, onChange }: ReviewSettingsPanelProps) {
  const current = repo.parsedJson.review;

  // Triggers
  const [onEvents, setOnEvents] = useState<ReviewOn[]>([...current.on]);
  const [ignoreDrafts, setIgnoreDrafts] = useState(current.ignore_drafts);
  const [mentionEnabled, setMentionEnabled] = useState(current.mention_trigger !== false);
  const [mentionValue, setMentionValue] = useState(
    current.mention_trigger === false ? '' : current.mention_trigger,
  );

  // Limits
  const [maxFiles, setMaxFiles] = useState(String(current.max_files));
  const [maxComments, setMaxComments] = useState(String(current.max_comments));
  const [largeFileThreshold, setLargeFileThreshold] = useState(String(current.large_file_threshold_lines));
  const [maxDiffLines, setMaxDiffLines] = useState(String(current.max_diff_lines_per_file));
  const [maxTotalDiffChars, setMaxTotalDiffChars] = useState(String(current.max_total_diff_chars));
  const [minSeverity, setMinSeverity] = useState<ReviewSeverity>(current.min_severity);
  const [minConfidence, setMinConfidence] = useState(String(current.min_confidence));

  // Filters
  const [skipFiles, setSkipFiles] = useState<string[]>([...current.skip_files]);
  const [customRules, setCustomRules] = useState<string[]>([...current.custom_rules]);
  const [focus, setFocus] = useState<ReviewCategory[]>([...current.focus]);

  // Passes
  const [securityEnabled, setSecurityEnabled] = useState(current.passes.security.enabled);
  const [crossFileEnabled, setCrossFileEnabled] = useState(current.passes.security.cross_file);
  const [criticEnabled, setCriticEnabled] = useState(current.passes.critic.enabled);
  const [walkthroughEnabled, setWalkthroughEnabled] = useState(current.walkthrough.enabled);
  const [seqDiagramEnabled, setSeqDiagramEnabled] = useState(current.walkthrough.sequence_diagram.enabled);

  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [severityEngineEnabled, setSeverityEngineEnabled] = useState(current.severity_engine.enabled);
  const [dedupEnabled, setDedupEnabled] = useState(current.dedup.enabled);
  const [fileSelectionEnabled, setFileSelectionEnabled] = useState(current.file_selection.enabled);
  const [ensembleRuns, setEnsembleRuns] = useState(String(current.passes.ensemble.runs));
  const [categoryInputs, setCategoryInputs] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const category of reviewCategories) {
      const value = current.category_confidence[category];
      seed[category] = value === undefined ? '' : String(value);
    }
    return seed;
  });
  const [verifyFixes, setVerifyFixes] = useState(current.threads.verify_fixes);
  const [autoResolve, setAutoResolve] = useState(current.threads.auto_resolve);
  const [roundsIncremental, setRoundsIncremental] = useState(current.rounds.incremental);
  const [escalateFloors, setEscalateFloors] = useState(current.rounds.escalate_floors);
  const [evidenceHardDrop, setEvidenceHardDrop] = useState(current.evidence?.hard_drop ?? false);
  const [evidenceExemptCategories, setEvidenceExemptCategories] = useState<string[]>(
    current.evidence?.hard_drop_exempt_categories ?? ['security'],
  );

  const draftMentionTrigger: false | string = mentionEnabled ? mentionValue : false;
  const draftCategoryConfidence = buildCategoryConfidence(categoryInputs);

  // Immutable nested spread from the FULL current review — unedited nested knobs
  // (passes.critic.skip_threshold/input_char_budget, passes.ensemble.temperature) and
  // the D-03-excluded exec/labels are carried through unchanged (REVIEW #5 / prohibition).
  const review: ReviewConfig = {
    ...current,
    on: onEvents,
    ignore_drafts: ignoreDrafts,
    mention_trigger: draftMentionTrigger,
    skip_files: skipFiles,
    custom_rules: customRules,
    max_files: parseNum(maxFiles),
    max_comments: parseNum(maxComments),
    large_file_threshold_lines: parseNum(largeFileThreshold),
    max_diff_lines_per_file: parseNum(maxDiffLines),
    max_total_diff_chars: parseNum(maxTotalDiffChars),
    min_severity: minSeverity,
    min_confidence: parseNum(minConfidence),
    focus,
    category_confidence: draftCategoryConfidence,
    passes: {
      ...current.passes,
      security: { ...current.passes.security, enabled: securityEnabled, cross_file: crossFileEnabled },
      critic: { ...current.passes.critic, enabled: criticEnabled },
      ensemble: { ...current.passes.ensemble, runs: parseNum(ensembleRuns) },
    },
    walkthrough: {
      ...current.walkthrough,
      enabled: walkthroughEnabled,
      sequence_diagram: { ...current.walkthrough.sequence_diagram, enabled: seqDiagramEnabled },
    },
    severity_engine: { ...current.severity_engine, enabled: severityEngineEnabled },
    dedup: { ...current.dedup, enabled: dedupEnabled },
    file_selection: { ...current.file_selection, enabled: fileSelectionEnabled },
    threads: { ...current.threads, verify_fixes: verifyFixes, auto_resolve: autoResolve },
    rounds: { ...current.rounds, incremental: roundsIncremental, escalate_floors: escalateFloors },
    evidence: {
      hard_drop: evidenceHardDrop,
      hard_drop_exempt_categories: evidenceExemptCategories,
    },
  };

  // Enable-but-empty mention_trigger is INVALID (REVIEW #8): a whitespace-only value
  // would pass schema.min(1) but must never round-trip, so guard it here explicitly.
  const mentionValid = !mentionEnabled || mentionValue.trim().length > 0;
  // WR-02: an out-of-range per-category confidence override must BLOCK Apply (like
  // min_confidence) instead of being silently dropped by buildCategoryConfidence and
  // resetting the category to "inherit global" on save.
  const valid =
    reviewConfigSchema.safeParse(review).success && mentionValid && categoryConfidenceValid(categoryInputs);

  const dirty =
    !stringSetEqual(onEvents, current.on) ||
    ignoreDrafts !== current.ignore_drafts ||
    draftMentionTrigger !== current.mention_trigger ||
    !orderedListEqual(skipFiles, current.skip_files) ||
    !orderedListEqual(customRules, current.custom_rules) ||
    parseNum(maxFiles) !== current.max_files ||
    parseNum(maxComments) !== current.max_comments ||
    parseNum(largeFileThreshold) !== current.large_file_threshold_lines ||
    parseNum(maxDiffLines) !== current.max_diff_lines_per_file ||
    parseNum(maxTotalDiffChars) !== current.max_total_diff_chars ||
    minSeverity !== current.min_severity ||
    parseNum(minConfidence) !== current.min_confidence ||
    !stringSetEqual(focus, current.focus) ||
    !categoryConfidenceEqual(draftCategoryConfidence, current.category_confidence) ||
    securityEnabled !== current.passes.security.enabled ||
    crossFileEnabled !== current.passes.security.cross_file ||
    criticEnabled !== current.passes.critic.enabled ||
    parseNum(ensembleRuns) !== current.passes.ensemble.runs ||
    walkthroughEnabled !== current.walkthrough.enabled ||
    seqDiagramEnabled !== current.walkthrough.sequence_diagram.enabled ||
    severityEngineEnabled !== current.severity_engine.enabled ||
    dedupEnabled !== current.dedup.enabled ||
    fileSelectionEnabled !== current.file_selection.enabled ||
    verifyFixes !== current.threads.verify_fixes ||
    autoResolve !== current.threads.auto_resolve ||
    roundsIncremental !== current.rounds.incremental ||
    escalateFloors !== current.rounds.escalate_floors ||
    evidenceHardDrop !== (current.evidence?.hard_drop ?? false) ||
    !orderedListEqual(evidenceExemptCategories, current.evidence?.hard_drop_exempt_categories ?? ['security']);

  // Report the draft up to the modal (single-Apply). Deps mirror InteractivePanel:266-288 —
  // re-report whenever an editable field or a derived flag changes, so a post-save repo refresh
  // re-reports dirty:false. onChange is a stable parent setter.
  useEffect(() => {
    onChange({ review, dirty, valid });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onEvents,
    ignoreDrafts,
    mentionEnabled,
    mentionValue,
    maxFiles,
    maxComments,
    largeFileThreshold,
    maxDiffLines,
    maxTotalDiffChars,
    minSeverity,
    minConfidence,
    skipFiles,
    customRules,
    focus,
    securityEnabled,
    crossFileEnabled,
    criticEnabled,
    walkthroughEnabled,
    seqDiagramEnabled,
    severityEngineEnabled,
    dedupEnabled,
    fileSelectionEnabled,
    ensembleRuns,
    categoryInputs,
    verifyFixes,
    autoResolve,
    roundsIncremental,
    escalateFloors,
    evidenceHardDrop,
    evidenceExemptCategories,
    dirty,
    valid,
  ]);

  const severityOptions = reviewSeverities.map((severity) => ({ value: severity, label: severity }));

  return (
    <div className="flex flex-col gap-6">
      {/* Triggers */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          title="Triggers"
          description="Choose which pull-request events start a review and how the bot is invoked."
        />
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
          <p className="text-sm font-medium text-foreground">Review on</p>
          <p className="text-xs text-muted-foreground">Pull-request events that trigger an automated review.</p>
          <div className="flex flex-col gap-2">
            {REVIEW_EVENTS.map((event) => (
              <label key={event.value} className="flex items-center justify-between gap-4">
                <span className="text-sm text-foreground">{event.label}</span>
                <Switch
                  checked={onEvents.includes(event.value)}
                  onCheckedChange={() => setOnEvents((list) => toggleValue(list, event.value))}
                  aria-label={`Trigger review on ${event.label}`}
                />
              </label>
            ))}
          </div>
        </div>
        <ToggleRow
          label="Ignore draft pull requests"
          description="Skip reviews while a PR is still a draft."
          checked={ignoreDrafts}
          onCheckedChange={setIgnoreDrafts}
          ariaLabel="Toggle ignore draft pull requests"
        />
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Mention trigger</p>
              <p className="text-xs text-muted-foreground">Re-run a review when this handle is mentioned on the PR.</p>
            </div>
            <Switch
              checked={mentionEnabled}
              onCheckedChange={setMentionEnabled}
              aria-label="Enable mention trigger"
            />
          </div>
          {mentionEnabled && (
            <>
              <Input
                value={mentionValue}
                onChange={(event) => setMentionValue(event.target.value)}
                placeholder="e.g. @codra-app"
                aria-label="Mention trigger handle"
                aria-invalid={!mentionValid}
                className="font-mono text-xs"
              />
              {!mentionValid && (
                <p className="text-xs text-destructive">Enter a handle, or turn the mention trigger off.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Limits */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          title="Limits"
          description="Bound review size and how findings are filtered before posting."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label="Max files"
            value={maxFiles}
            onChange={setMaxFiles}
            min={1}
            max={150}
            ariaLabel="Max files"
          />
          <NumberField
            label="Max comments"
            value={maxComments}
            onChange={setMaxComments}
            min={1}
            max={150}
            ariaLabel="Max comments"
          />
          <NumberField
            label="Large file threshold (lines)"
            value={largeFileThreshold}
            onChange={setLargeFileThreshold}
            min={1}
            max={5000}
            ariaLabel="Large file threshold lines"
          />
          <NumberField
            label="Max diff lines per file"
            value={maxDiffLines}
            onChange={setMaxDiffLines}
            min={1}
            max={5000}
            ariaLabel="Max diff lines per file"
          />
          <NumberField
            label="Max total diff characters"
            value={maxTotalDiffChars}
            onChange={setMaxTotalDiffChars}
            min={1}
            max={500000}
            ariaLabel="Max total diff characters"
          />
          <NumberField
            label="Minimum confidence"
            value={minConfidence}
            onChange={setMinConfidence}
            min={0}
            max={1}
            step={0.05}
            ariaLabel="Minimum confidence"
          />
        </div>
        <Select
          label="Minimum severity"
          variant="card"
          value={minSeverity}
          onValueChange={(value) => setMinSeverity(value as ReviewSeverity)}
          options={severityOptions}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          title="Filters"
          description="Skip files, add custom review rules, and scope which categories are reviewed."
        />
        <ListEditor
          title="Skip files"
          hint="Glob patterns for files to exclude from review."
          items={skipFiles}
          onChange={setSkipFiles}
          placeholder="e.g. dist/**"
          addAriaLabel="New skip-file pattern"
          emptyHint="No skip patterns yet. Add a glob to exclude files from review."
        />
        <ListEditor
          title="Custom rules"
          hint="Up to 50 rules, 500 characters each."
          items={customRules}
          onChange={setCustomRules}
          placeholder="e.g. Flag any use of console.log"
          addAriaLabel="New custom rule"
          emptyHint="No custom rules yet. Add project-specific guidance for the reviewer."
        />
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
          <p className="text-sm font-medium text-foreground">Focus categories</p>
          <p className="text-xs text-muted-foreground">Limit findings to these review categories.</p>
          <div className="flex flex-col gap-2">
            {reviewCategories.map((category) => (
              <label key={category} className="flex items-center justify-between gap-4">
                <span className="text-sm capitalize text-foreground">{category}</span>
                <Switch
                  checked={focus.includes(category)}
                  onCheckedChange={() => setFocus((list) => toggleValue(list, category))}
                  aria-label={`Focus on ${category}`}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Passes */}
      <div className="flex flex-col gap-4">
        <SectionHeading
          title="Passes"
          description="Extra review passes layered on top of the base review."
        />
        <ToggleRow
          label="Security pass"
          description="Run a dedicated security-focused review pass."
          checked={securityEnabled}
          onCheckedChange={setSecurityEnabled}
          ariaLabel="Toggle security pass"
        />
        <ToggleRow
          label="Cross-file security"
          description="Analyze security implications across file boundaries (e.g., auth changes + unprotected routes)."
          checked={crossFileEnabled}
          onCheckedChange={setCrossFileEnabled}
          ariaLabel="Toggle cross-file security"
        />
        <ToggleRow
          label="Critic pass"
          description="Prune low-value findings with a second-opinion critic pass."
          checked={criticEnabled}
          onCheckedChange={setCriticEnabled}
          ariaLabel="Toggle critic pass"
        />
        <ToggleRow
          label="Walkthrough"
          description="Post a high-level walkthrough summary of the changes."
          checked={walkthroughEnabled}
          onCheckedChange={setWalkthroughEnabled}
          ariaLabel="Toggle walkthrough"
        />
        <ToggleRow
          label="Sequence diagram"
          description="Include a Mermaid sequence diagram in the walkthrough (GitHub only)."
          checked={seqDiagramEnabled}
          onCheckedChange={setSeqDiagramEnabled}
          ariaLabel="Toggle sequence diagram"
        />
      </div>

      {/* Advanced */}
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <SectionHeading
            title="Advanced"
            description="Correctness escape hatches and per-category tuning. Change with care."
          />
          <ChevronDown
            size={16}
            className={cn('shrink-0 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')}
          />
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <ToggleRow
                label="Severity engine"
                description="Deterministic severity assignment for findings."
                checked={severityEngineEnabled}
                onCheckedChange={setSeverityEngineEnabled}
                ariaLabel="Toggle severity engine"
              />
              <p className="text-warning text-xs">Disabling reverts a v1.2 correctness improvement.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <ToggleRow
                label="Deduplication"
                description="Collapse duplicate findings across passes."
                checked={dedupEnabled}
                onCheckedChange={setDedupEnabled}
                ariaLabel="Toggle deduplication"
              />
              <p className="text-warning text-xs">Disabling reverts a v1.2 correctness improvement.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <ToggleRow
                label="Priority file selection"
                description="Review the highest-signal files first and skip generated files."
                checked={fileSelectionEnabled}
                onCheckedChange={setFileSelectionEnabled}
                ariaLabel="Toggle priority file selection"
              />
              <p className="text-warning text-xs">Disabling reverts a v1.2 correctness improvement.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <NumberField
                label="Ensemble runs"
                value={ensembleRuns}
                onChange={setEnsembleRuns}
                min={1}
                max={5}
                ariaLabel="Ensemble runs"
                className="max-w-[160px]"
              />
              <p className="text-warning text-xs">
                Higher runs increase model cost and the per-invocation subrequest budget.
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/40 p-3">
              <p className="text-sm font-medium text-foreground">Per-category confidence</p>
              <p className="text-xs text-muted-foreground">Empty = inherit the global minimum confidence.</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {reviewCategories.map((category) => {
                  const categoryValid = categoryConfidenceValueValid(categoryInputs[category] ?? '');
                  return (
                    <label key={category} className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium capitalize text-foreground">{category}</span>
                      <Input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={categoryInputs[category] ?? ''}
                        onChange={(event) =>
                          setCategoryInputs((inputs) => ({ ...inputs, [category]: event.target.value }))
                        }
                        aria-label={`${category} confidence override`}
                        aria-invalid={!categoryValid}
                      />
                      {!categoryValid && (
                        <span className="text-xs text-destructive">
                          Enter a value between 0 and 1, or leave empty to inherit.
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
            <ToggleRow
              label="Verify fixes"
              description="Re-check threaded findings once a fix is pushed."
              checked={verifyFixes}
              onCheckedChange={setVerifyFixes}
              ariaLabel="Toggle verify fixes"
            />
            <ToggleRow
              label="Auto-resolve threads"
              description="Resolve finding threads automatically once addressed."
              checked={autoResolve}
              onCheckedChange={setAutoResolve}
              ariaLabel="Toggle auto-resolve threads"
            />
            <ToggleRow
              label="Incremental rounds"
              description="Only review changes since the last review round."
              checked={roundsIncremental}
              onCheckedChange={setRoundsIncremental}
              ariaLabel="Toggle incremental rounds"
            />
            <ToggleRow
              label="Escalate floors"
              description="Raise severity floors on repeated review rounds."
              checked={escalateFloors}
              onCheckedChange={setEscalateFloors}
              ariaLabel="Toggle escalate floors"
            />
            <ToggleRow
              label="Evidence hard-drop"
              description="Drop findings whose existing_code evidence is not found in the hunk (hallucinated evidence)."
              checked={evidenceHardDrop}
              onCheckedChange={setEvidenceHardDrop}
              ariaLabel="Toggle evidence hard-drop"
            />
            <ListEditor
              title="Exempt categories"
              hint="Categories that always post findings regardless of evidence quality. Default: security."
              items={evidenceExemptCategories}
              onChange={(newItems) => {
                // REVIEWS FINDING #10: normalize exempt categories to lowercase on save to prevent silent
                // case-sensitivity mismatches between the config value (e.g., 'Security') and the
                // reviewCategories enum value ('security'). Lowercasing at the input boundary ensures the
                // checkEvidence comparison (which lowercases both sides) always matches.
                setEvidenceExemptCategories(newItems.map((item) => item.toLowerCase()));
              }}
              placeholder="e.g. correctness"
              addAriaLabel="New exempt category"
              emptyHint="All categories are subject to hard-drop. No exemptions."
            />
          </div>
        )}
      </div>
    </div>
  );
}
