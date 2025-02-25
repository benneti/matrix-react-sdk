/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { DEFAULT_WAVEFORM, Playback } from "./Playback";
import { PlaybackManager } from "./PlaybackManager";

/**
 * A managed playback is a Playback instance that is guided by a PlaybackManager.
 */
export class ManagedPlayback extends Playback {
    public constructor(private manager: PlaybackManager, buf: ArrayBuffer, seedWaveform = DEFAULT_WAVEFORM) {
        super(buf, seedWaveform);
    }

    public async play(): Promise<void> {
        this.manager.playOnly(this);
        return super.play();
    }

    public destroy() {
        this.manager.destroyPlaybackInstance(this);
        super.destroy();
    }
}
