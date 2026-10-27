import { scoutConfig } from './verkenner.config.js';
import { resolveScoutSetup } from './verkenner.setup.js';

const valid = { SCOUT_ENABLED: 'true', SCOUT_USER_EMAIL: 'verkenner@example.com', SCOUT_MODEL: 'openai/scout-model', OPENAI_API_KEY: 'sk-secret-value' };

describe('scoutConfig', () => {
    it('is on with the flag, user, model and key, and applies the defaults', () => {
        expect(scoutConfig(valid)).toEqual({
            enabled: true, model: 'openai/scout-model', userEmail: 'verkenner@example.com',
            summaryHourUtc: 6, maxWakesPerDay: 6, dailySuggestions: 3, maxSteps: 30,
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

    it('never puts the key in the reason', () => {
        const config = scoutConfig({ ...valid, SCOUT_MODEL: 'bad' });
        expect(JSON.stringify(config)).not.toContain('sk-secret-value');
    });
});

describe('resolveScoutSetup', () => {
    const logger = () => ({ log: vi.fn(), warn: vi.fn() });
    const user = { id: 'u-1', name: 'Verkenner', email: 'verkenner@example.com' };

    it('resolves the existing user through findByEmail and never creates one', async () => {
        const findByEmail = vi.fn().mockResolvedValue(user);
        const setup = await resolveScoutSetup({ findByEmail }, valid, logger());
        expect(findByEmail).toHaveBeenCalledWith('verkenner@example.com');
        expect(setup).toMatchObject({ config: { enabled: true, model: 'openai/scout-model' }, user });
    });

    it('stays off, with a warning and without throwing, when the user does not exist', async () => {
        const log = logger();
        expect(await resolveScoutSetup({ findByEmail: vi.fn().mockResolvedValue(null) }, valid, log)).toBeNull();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('does not match an existing user'));
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('verkenner@example.com');
    });

    it('stays off when the lookup fails', async () => {
        const log = logger();
        expect(await resolveScoutSetup({ findByEmail: vi.fn().mockRejectedValue(new Error('db down')) }, valid, log)).toBeNull();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });

    it('does not look anyone up when the configuration is off, and logs at info level when the flag is simply unset', async () => {
        const findByEmail = vi.fn();
        const log = logger();
        expect(await resolveScoutSetup({ findByEmail }, {}, log)).toBeNull();
        expect(findByEmail).not.toHaveBeenCalled();
        expect(log.log).toHaveBeenCalledWith(expect.stringContaining('SCOUT_ENABLED'));
        expect(log.warn).not.toHaveBeenCalled();

        const broken = logger();
        await resolveScoutSetup({ findByEmail }, { ...valid, SCOUT_MODEL: 'bad' }, broken);
        expect(broken.warn).toHaveBeenCalled();
    });
});
