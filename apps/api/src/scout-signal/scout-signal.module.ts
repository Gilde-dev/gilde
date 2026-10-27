import { Global, Module } from '@nestjs/common';

import { ScoutSignalPublisher } from './scout-signal.publisher.js';

/** Global so producers in any domain can inject the publisher without importing the co-pilot. */
@Global()
@Module({ providers: [ScoutSignalPublisher], exports: [ScoutSignalPublisher] })
export class ScoutSignalModule { }
