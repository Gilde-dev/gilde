import { scoutConfig } from './verkenner.config.js';
import { resolveScoutSetup, resolveScoutState } from './verkenner.setup.js';

const valid = { SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'verkenner@example.com', SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'sk-secret-value' };

describe('scoutConfig', () => {
    it('is on with the flag, user, model and key, and applies the defaults', () => {
        expect(scoutConfig(valid)).toEqual({
            enabled: true, model: 'openai/scout-model', userEmail: 'verkenner@example.com',
            summaryHourUtc: 6, maxWakesPerDay: 6, dailySuggestions: 3, patternMinSize: 4, maxSteps: 30,
        });
    });

    it('falls back to COPILOT_MODEL, and SCOUT_MODEL wins when both are set', () => {
        const { SCOUT_MODEL, ...rest } = valid;
        expect(SCOUT_MODEL).toBeDefined();
        expect(scoutConfig({ ...rest, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ enabled: true, model: 'openai/copilot-model' });
        expect(scoutConfig({ ...valid, COPILOT_MODEL: 'openai/copilot-model' })).toMatchObject({ model: 'openai/scout-model' });
    });

    it('works without any co-pilot setting (configured independently)', () => {
        expect(scoutConfig(valid).enabled).toBe(true);
    });

    it.each(['', 'false', '1', 'TRUE', 'yes', ' false '])('is off unless SCOUT_ENABLED is literally true (%j)', (flag) => {
        expect(scoutConfig({ ...valid, SCOUT_ENABLED: flag })).toMatchObject({ enabled: false, model: null });
    });

    it('is off without a user, model or provider key, or with an unsupported model', () => {
        expect(scoutConfig({ ...valid, SCOUT_USER_EMAIL: ' ' })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_USER_EMAIL') });
        expect(scoutConfig({ ...valid, SCOUT_MODEL: '' })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_MODEL') });
        expect(scoutConfig({ ...valid, SCOUT_MODEL: 'anthropic/x' })).toMatchObject({ enabled: false, reason: expect.stringContaining('openai/') });
        expect(scoutConfig({ ...valid, SCOUT_MODEL: 'openai/' })).toMatchObject({ enabled: false });
        expect(scoutConfig({ ...valid, OPENAI_API_KEY: '' })).toMatchObject({ enabled: false, reason: expect.stringContaining('OPENAI_API_KEY') });
    });

    it('parses the numeric settings and disables the scout on an explicit invalid value', () => {
        expect(scoutConfig({ ...valid, SCOUT_SUMMARY_HOUR_UTC: '0', SCOUT_MAX_WAKES_PER_DAY: '2', SCOUT_DAILY_SUGGESTIONS: '1' })).toMatchObject({ summaryHourUtc: 0, maxWakesPerDay: 2, dailySuggestions: 1 });
        expect(scoutConfig({ ...valid, SCOUT_SUMMARY_HOUR_UTC: '23' })).toMatchObject({ summaryHourUtc: 23 });
        expect(scoutConfig({ ...valid, SCOUT_SUMMARY_HOUR_UTC: ' ' })).toMatchObject({ enabled: true, summaryHourUtc: 6 });
        for (const bad of ['24', '-1', '6.5', 'six', '1e1']) {
            expect(scoutConfig({ ...valid, SCOUT_SUMMARY_HOUR_UTC: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_SUMMARY_HOUR_UTC') });
        }
        for (const bad of ['0', '-3', '2.5', 'many']) {
            expect(scoutConfig({ ...valid, SCOUT_MAX_WAKES_PER_DAY: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_MAX_WAKES_PER_DAY') });
            expect(scoutConfig({ ...valid, SCOUT_DAILY_SUGGESTIONS: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_DAILY_SUGGESTIONS') });
        }
    });

    it('reads SCOUT_PATTERN_MIN_SIZE (default 4) and disables the scout on an invalid value', () => {
        expect(scoutConfig({ ...valid, SCOUT_PATTERN_MIN_SIZE: '6' })).toMatchObject({ enabled: true, patternMinSize: 6 });
        expect(scoutConfig({ ...valid, SCOUT_PATTERN_MIN_SIZE: ' ' })).toMatchObject({ enabled: true, patternMinSize: 4 });
        for (const bad of ['1', '0', '101', '2.5', 'many', '-4']) {
            expect(scoutConfig({ ...valid, SCOUT_PATTERN_MIN_SIZE: bad })).toMatchObject({ enabled: false, reason: expect.stringContaining('SCOUT_PATTERN_MIN_SIZE') });
        }
    });

    it('never puts the key in the reason', () => {
        const config = scoutConfig({ ...valid, SCOUT_MODEL: 'bad' });
        expect(JSON.stringify(config)).not.toContain('sk-secret-value');
    });
});

describe('resolveScoutSetup', () => {
    const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const user = { id: 'u-1', name: 'Verkenner', email: 'verkenner@example.com' };
    const bot = { findIdentity: vi.fn().mockResolvedValue({ id: 'u-1', isBot: true }) };

    it('resolves the existing bot user through findByEmail and never creates one', async () => {
        const findByEmail = vi.fn().mockResolvedValue(user);
        const state = await resolveScoutState({ findByEmail, ...bot }, valid, logger());
        expect(findByEmail).toHaveBeenCalledWith('verkenner@example.com');
        expect(state.setup).toMatchObject({ config: { enabled: true, model: 'openai/scout-model' }, user });
        expect(state.disabledReason).toBeNull();
    });

    it('is disabled, with an error line and a disabledReason, when the user is not a bot', async () => {
        const log = logger();
        const state = await resolveScoutState({ findByEmail: vi.fn().mockResolvedValue(user), findIdentity: vi.fn().mockResolvedValue({ id: 'u-1', isBot: false }) }, valid, log);
        const reason = 'SCOUT_USER_EMAIL verkenner@example.com is not a bot account; mark it with `user:mark-bot --email verkenner@example.com` and restart';
        expect(state).toEqual({ setup: null, disabledReason: reason });
        expect(log.error).toHaveBeenCalledWith(`Verkenner disabled: ${reason}`);
        expect(await resolveScoutSetup({ findByEmail: vi.fn().mockResolvedValue(user), findIdentity: vi.fn().mockResolvedValue(null) }, valid, logger())).toBeNull();
    });

    it('is disabled, without throwing, when the user does not exist', async () => {
        const log = logger();
        const state = await resolveScoutState({ findByEmail: vi.fn().mockResolvedValue(null), ...bot }, valid, log);
        expect(state.setup).toBeNull();
        expect(state.disabledReason).toContain('SCOUT_USER_EMAIL verkenner@example.com does not exist');
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Verkenner disabled: SCOUT_USER_EMAIL verkenner@example.com does not exist'));
    });

    it('is disabled when the lookup fails', async () => {
        const log = logger();
        const state = await resolveScoutState({ findByEmail: vi.fn().mockRejectedValue(new Error('db down')), ...bot }, valid, log);
        expect(state.setup).toBeNull();
        expect(state.disabledReason).toContain('db down');
        expect(log.error).toHaveBeenCalled();
    });

    it('does not look anyone up when the configuration is off, and logs at info level when the flag is simply unset', async () => {
        const findByEmail = vi.fn();
        const log = logger();
        expect(await resolveScoutState({ findByEmail, ...bot }, {}, log)).toEqual({ setup: null, disabledReason: null });
        expect(findByEmail).not.toHaveBeenCalled();
        expect(log.log).toHaveBeenCalledWith(expect.stringContaining('SCOUT_ENABLED'));
        expect(log.warn).not.toHaveBeenCalled();

        const broken = logger();
        const state = await resolveScoutState({ findByEmail, ...bot }, { ...valid, SCOUT_MODEL: 'bad' }, broken);
        expect(broken.warn).toHaveBeenCalled();
        expect(state.disabledReason).toContain('SCOUT_MODEL');
    });
});
