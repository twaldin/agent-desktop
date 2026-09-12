import { useState } from 'react';
import type { AutomationInput, AutomationInputDestination } from '../../../../packages/shared/src/automations';
import type { ModelInfo, Project, SessionSummary } from '../../../../packages/shared/src/protocol';
import { CompactSelect } from './CompactSelect';
import { ModelPicker } from './ModelPicker';
import { readSchedule, scheduleRule, type ScheduleForm, type ScheduleMode } from './automation-form';

export function AutomationEditor({ initial, initialSchedule, hostName, projects, sessions, models, busy, isNew, onChange, onSave, onCancel }: {
  initial: AutomationInput; initialSchedule?: ScheduleForm; hostName: string; projects: Project[]; sessions: SessionSummary[]; models: ModelInfo[];
  busy: boolean; isNew: boolean; onChange(input: AutomationInput, schedule: ScheduleForm): void; onSave(input: AutomationInput): void; onCancel(): void;
}) {
  const [input, setInput] = useState(initial), [schedule, setSchedule] = useState(() => initialSchedule ?? readSchedule(initial.rrule));
  let error: string | undefined;
  try { scheduleRule(schedule); } catch (cause) { error = cause instanceof Error ? cause.message : 'Invalid schedule.'; }
  const update = (next: AutomationInput) => { setInput(next); onChange(next, schedule); };
  function changeSchedule(next: ScheduleForm) {
    setSchedule(next);
    let nextInput = input;
    try { nextInput = { ...input, rrule: scheduleRule(next) }; } catch { /* Keep incomplete controls visible and unsavable. */ }
    setInput(nextInput); onChange(nextInput, next);
  }
  function changeDestination(value: string) {
    let destination: AutomationInputDestination;
    const defaultCreation = { projectId: null, execution: { type: 'local' as const }, environment: null, thinkingLevel: null, approvalMode: null };
    if (value === 'heartbeat-new') destination = { kind: 'heartbeat-new', ...defaultCreation, model: null };
    else if (value === 'cron') {
      const model = models.find(model => model.available !== false && model.authenticated);
      // Empty model values remain an unsaved form error, never dispatched as an invented native model.
      destination = { kind: 'cron', ...defaultCreation, model: model ? { provider: model.provider, id: model.id } : { provider: '', id: '' } };
    } else destination = { kind: 'heartbeat', sessionId: value.slice('session:'.length) };
    update({ ...input, destination });
  }
  const destination = input.destination;
  const selectedSession = destination.kind === 'heartbeat' ? sessions.find(session => session.id === destination.sessionId) : undefined;
  const destinationValue = destination.kind === 'heartbeat' ? `session:${destination.sessionId}` : destination.kind;
  const creation = destination.kind === 'cron' ? destination : undefined;
  const currentModel = creation && models.find(model => model.id === creation.model.id && model.provider === creation.model.provider);
  const modelValue = creation ? JSON.stringify([creation.model.provider, creation.model.id]) : '';
  const modes: [ScheduleMode, string][] = [['hourly', 'Hourly'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['custom', 'Custom']];
  const destinations = sessions.filter(session => !session.archived);
  return <form className="automation-editor" onSubmit={event => { event.preventDefault(); if (!error && !busy) onSave(input); }}>
    <div className="automation-editor-scroll">
      <input className="automation-title" autoFocus aria-label="Scheduled task title" placeholder="Scheduled task title" value={input.name} maxLength={200} disabled={busy} onChange={event => update({ ...input, name: event.target.value })}/>
      <textarea className="automation-prompt" aria-label="Scheduled task prompt" placeholder="Describe what the agent should do" value={input.prompt} maxLength={100_000} disabled={busy} onChange={event => update({ ...input, prompt: event.target.value })}/>
      <h3>Details</h3>
      <div className="automation-fields">
        <div className="automation-field"><span>Runs on</span><span>{hostName}</span></div>
        <div className="automation-field"><span>Runs in</span><CompactSelect label="Scheduled task destination" value={destinationValue} disabled={busy}
          displayValue={destination.kind === 'cron' ? 'New chat every run' : destination.kind === 'heartbeat-new' ? 'New chat for this task' : selectedSession?.title || 'Unavailable original chat'} onChange={changeDestination}>
          {isNew && <option value="heartbeat-new">New chat for this task</option>}
          <option value="cron">New chat every run</option>
          {destination.kind === 'heartbeat' && !destinations.some(session => session.id === destination.sessionId) && <option value={destinationValue}>Unavailable original chat</option>}
          <optgroup label="Existing chats">{destinations.map(session => <option key={session.id} value={`session:${session.id}`}>{session.title}</option>)}</optgroup>
        </CompactSelect></div>
        {creation && <>
          <div className="automation-field"><span>Project</span><CompactSelect label="Scheduled task project" value={creation.projectId ?? ''} disabled={busy}
            displayValue={projects.find(project => project.id === creation.projectId)?.name || (creation.projectId ? 'Unavailable project' : 'None')}
            onChange={value => update({ ...input, destination: { ...creation, projectId: value || null, execution: { type: 'local' }, environment: null } })}>
            <option value="">Don’t work in a project</option>{creation.projectId && !projects.some(project => project.id === creation.projectId) && <option value={creation.projectId}>Unavailable project</option>}
            {projects.filter(project => !project.removedAt).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </CompactSelect></div>
          <div className="automation-field"><span>Model</span><ModelPicker label="Scheduled task model" value={modelValue} disabled={busy}
            displayValue={currentModel?.name || creation.model.id || 'Choose a model'} options={models.map(model => ({ value: JSON.stringify([model.provider, model.id]), label: model.name,
              provider: model.provider, disabled: model.available === false || !model.authenticated, detail: !model.authenticated ? 'Sign in to this provider' : undefined }))}
            onChange={value => { const model = models.find(model => JSON.stringify([model.provider, model.id]) === value); if (model) update({ ...input, destination: { ...creation, model: { id: model.id, provider: model.provider }, thinkingLevel: null } }); }}/></div>
          <div className="automation-field"><span>Reasoning</span><CompactSelect label="Scheduled task reasoning" value={creation.thinkingLevel ?? ''} disabled={busy || !currentModel}
            displayValue={creation.thinkingLevel || 'Default'} onChange={value => update({ ...input, destination: { ...creation, thinkingLevel: value || null } })}>
            <option value="">Default</option>{(currentModel?.thinkingLevels ?? []).map(level => <option key={level} value={level}>{level}</option>)}
            {creation.thinkingLevel && !currentModel?.thinkingLevels?.includes(creation.thinkingLevel) && <option value={creation.thinkingLevel}>Unavailable: {creation.thinkingLevel}</option>}
          </CompactSelect></div>
          {!isNew && creation.execution.type === 'worktree' && <div className="automation-field"><span>Execution</span><span>Saved worktree configuration</span></div>}
        </>}
      </div>
      <h3>Frequency</h3>
      <div className="automation-fields">
        <div className="automation-field"><span>Repeat</span><CompactSelect label="Scheduled task repeat" value={schedule.mode} disabled={busy} displayValue={modes.find(([mode]) => mode === schedule.mode)?.[1] || 'Custom'}
          onChange={value => changeSchedule({ ...schedule, mode: value as ScheduleMode, ...(value === 'hourly' ? { every: destination.kind === 'cron' ? 1 : 30, intervalUnit: destination.kind === 'cron' ? 'hours' : 'minutes' } : {}), ...(value === 'custom' ? { raw: input.rrule } : {}) })}>
          {modes.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
        </CompactSelect></div>
        {schedule.mode === 'hourly' && <div className="automation-field"><label htmlFor="automation-interval">Every</label><span><input id="automation-interval" type="number" min="1" step="1" value={schedule.every} disabled={busy} onChange={event => changeSchedule({ ...schedule, every: event.target.valueAsNumber })}/> {schedule.intervalUnit}</span></div>}
        {schedule.mode === 'weekly' && <div className="automation-field"><span>On</span><div className="automation-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => <button key={day} type="button" aria-pressed={schedule.weekdays.includes(index)} disabled={busy}
          onClick={() => changeSchedule({ ...schedule, weekdays: schedule.weekdays.includes(index) ? schedule.weekdays.filter(value => value !== index) : [...schedule.weekdays, index].sort() })}>{day}</button>)}</div></div>}
        {schedule.mode === 'monthly' && <div className="automation-field"><label htmlFor="automation-day">On day</label><input id="automation-day" type="number" min="1" max="31" value={schedule.monthDay} disabled={busy} onChange={event => changeSchedule({ ...schedule, monthDay: event.target.valueAsNumber })}/></div>}
        {!['hourly', 'custom'].includes(schedule.mode) && <div className="automation-field"><label htmlFor="automation-time">At</label><input id="automation-time" type="time" value={schedule.time} disabled={busy} onChange={event => changeSchedule({ ...schedule, time: event.target.value })}/></div>}
        {schedule.mode === 'custom' && <label className="automation-rule">RRULE<textarea aria-label="Recurrence rule" value={schedule.raw} disabled={busy} onChange={event => changeSchedule({ ...schedule, raw: event.target.value })}/></label>}
        <div className="automation-field"><span>Notifications</span><CompactSelect label="Scheduled task notifications" value={input.notificationPolicy} disabled={busy}
          displayValue={input.notificationPolicy === 'all' ? 'All runs' : 'Failed runs only'} onChange={value => update({ ...input, notificationPolicy: value === 'all' ? 'all' : 'failed-runs-only' })}>
          <option value="all">All runs</option><option value="failed-runs-only">Failed runs only</option>
        </CompactSelect></div>
      </div>
      <p className="automation-host-note">Runs while {hostName} is available. Schedule times use that host’s local time unless the rule specifies a time zone.</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
    </div>
    <footer className="automation-editor-footer"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary-button" disabled={busy || !!error || !input.name.trim() || !input.prompt.trim()}>{busy ? 'Saving…' : isNew ? 'Create' : 'Save'}</button></footer>
  </form>;
}
