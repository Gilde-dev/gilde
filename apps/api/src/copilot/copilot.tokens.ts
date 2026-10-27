export const COPILOT_CONFIG = Symbol('COPILOT_CONFIG');
export const COPILOT_MASTRA = Symbol('COPILOT_MASTRA');
/** The enabled scout (config + bot user) or null when it is off. */
export const SCOUT_SETUP = Symbol('SCOUT_SETUP');
/** ScoutThreads of the scout, or null when it is off. */
export const SCOUT_THREADS = Symbol('SCOUT_THREADS');
/** Native delivery gate of the scout (bound to ScoutSignalService when the scout is on). */
export const SCOUT_GATE = Symbol('SCOUT_GATE');
/** ScoutSignalService, or null when the scout is off. */
export const SCOUT_SIGNALS = Symbol('SCOUT_SIGNALS');
