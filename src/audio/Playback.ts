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

import EventEmitter from "events";
import { UPDATE_EVENT } from "../stores/AsyncStore";
import { arrayFastResample, arrayRescale, arraySeed, arraySmoothingResample } from "../utils/arrays";
import { SimpleObservable } from "matrix-widget-api";
import { IDestroyable } from "../utils/IDestroyable";
import { PlaybackClock } from "./PlaybackClock";
import { createAudioContext, decodeOgg } from "./compat";
import { clamp } from "../utils/numbers";

export enum PlaybackState {
    Decoding = "decoding",
    Stopped = "stopped", // no progress on timeline
    Paused = "paused", // some progress on timeline
    Playing = "playing", // active progress through timeline
}

export const PLAYBACK_WAVEFORM_SAMPLES = 39;
const THUMBNAIL_WAVEFORM_SAMPLES = 100; // arbitrary: [30,120]
export const DEFAULT_WAVEFORM = arraySeed(0, PLAYBACK_WAVEFORM_SAMPLES);

function makePlaybackWaveform(input: number[]): number[] {
    // First, convert negative amplitudes to positive so we don't detect zero as "noisy".
    const noiseWaveform = input.map(v => Math.abs(v));

    // Then, we'll resample the waveform using a smoothing approach so we can keep the same rough shape.
    // We also rescale the waveform to be 0-1 so we end up with a clamped waveform to rely upon.
    return arrayRescale(arraySmoothingResample(noiseWaveform, PLAYBACK_WAVEFORM_SAMPLES), 0, 1);
}

export class Playback extends EventEmitter implements IDestroyable {
    /**
     * Stable waveform for representing a thumbnail of the media. Values are
     * guaranteed to be between zero and one, inclusive.
     */
    public readonly thumbnailWaveform: number[];

    private readonly context: AudioContext;
    private source: AudioBufferSourceNode | MediaElementAudioSourceNode;
    private state = PlaybackState.Decoding;
    private audioBuf: AudioBuffer;
    private element: HTMLAudioElement;
    private resampledWaveform: number[];
    private waveformObservable = new SimpleObservable<number[]>();
    private readonly clock: PlaybackClock;
    private readonly fileSize: number;

    /**
     * Creates a new playback instance from a buffer.
     * @param {ArrayBuffer} buf The buffer containing the sound sample.
     * @param {number[]} seedWaveform Optional seed waveform to present until the proper waveform
     * can be calculated. Contains values between zero and one, inclusive.
     */
    constructor(private buf: ArrayBuffer, seedWaveform = DEFAULT_WAVEFORM) {
        super();
        // Capture the file size early as reading the buffer will result in a 0-length buffer left behind
        this.fileSize = this.buf.byteLength;
        this.context = createAudioContext();
        this.resampledWaveform = arrayFastResample(seedWaveform ?? DEFAULT_WAVEFORM, PLAYBACK_WAVEFORM_SAMPLES);
        this.thumbnailWaveform = arrayFastResample(seedWaveform ?? DEFAULT_WAVEFORM, THUMBNAIL_WAVEFORM_SAMPLES);
        this.waveformObservable.update(this.resampledWaveform);
        this.clock = new PlaybackClock(this.context);
    }

    /**
     * Size of the audio clip in bytes. May be zero if unknown. This is updated
     * when the playback goes through phase changes.
     */
    public get sizeBytes(): number {
        return this.fileSize;
    }

    /**
     * Stable waveform for the playback. Values are guaranteed to be between
     * zero and one, inclusive.
     */
    public get waveform(): number[] {
        return this.resampledWaveform;
    }

    public get waveformData(): SimpleObservable<number[]> {
        return this.waveformObservable;
    }

    public get clockInfo(): PlaybackClock {
        return this.clock;
    }

    public get currentState(): PlaybackState {
        return this.state;
    }

    public get isPlaying(): boolean {
        return this.currentState === PlaybackState.Playing;
    }

    public emit(event: PlaybackState, ...args: any[]): boolean {
        this.state = event;
        super.emit(event, ...args);
        super.emit(UPDATE_EVENT, event, ...args);
        return true; // we don't ever care if the event had listeners, so just return "yes"
    }

    public destroy() {
        // noinspection JSIgnoredPromiseFromCall - not concerned about being called async here
        this.stop();
        this.removeAllListeners();
        this.clock.destroy();
        this.waveformObservable.close();
        if (this.element) {
            URL.revokeObjectURL(this.element.src);
            this.element.remove();
        }
    }

    public async prepare() {
        // The point where we use an audio element is fairly arbitrary, though we don't want
        // it to be too low. As of writing, voice messages want to show a waveform but audio
        // messages do not. Using an audio element means we can't show a waveform preview, so
        // we try to target the difference between a voice message file and large audio file.
        // Overall, the point of this is to avoid memory-related issues due to storing a massive
        // audio buffer in memory, as that can balloon to far greater than the input buffer's
        // byte length.
        if (this.buf.byteLength > 5 * 1024 * 1024) { // 5mb
            console.log("Audio file too large: processing through <audio /> element");
            this.element = document.createElement("AUDIO") as HTMLAudioElement;
            const prom = new Promise((resolve, reject) => {
                this.element.onloadeddata = () => resolve(null);
                this.element.onerror = (e) => reject(e);
            });
            this.element.src = URL.createObjectURL(new Blob([this.buf]));
            await prom; // make sure the audio element is ready for us
        } else {
            // Safari compat: promise API not supported on this function
            this.audioBuf = await new Promise((resolve, reject) => {
                this.context.decodeAudioData(this.buf, b => resolve(b), async e => {
                    try {
                        // This error handler is largely for Safari as well, which doesn't support Opus/Ogg
                        // very well.
                        console.error("Error decoding recording: ", e);
                        console.warn("Trying to re-encode to WAV instead...");

                        const wav = await decodeOgg(this.buf);

                        // noinspection ES6MissingAwait - not needed when using callbacks
                        this.context.decodeAudioData(wav, b => resolve(b), e => {
                            console.error("Still failed to decode recording: ", e);
                            reject(e);
                        });
                    } catch (e) {
                        console.error("Caught decoding error:", e);
                        reject(e);
                    }
                });
            });

            // Update the waveform to the real waveform once we have channel data to use. We don't
            // exactly trust the user-provided waveform to be accurate...
            const waveform = Array.from(this.audioBuf.getChannelData(0));
            this.resampledWaveform = makePlaybackWaveform(waveform);
        }

        this.waveformObservable.update(this.resampledWaveform);

        this.emit(PlaybackState.Stopped); // signal that we're not decoding anymore
        this.clock.flagLoadTime(); // must happen first because setting the duration fires a clock update
        this.clock.durationSeconds = this.element ? this.element.duration : this.audioBuf.duration;
    }

    private onPlaybackEnd = async () => {
        await this.context.suspend();
        this.emit(PlaybackState.Stopped);
    };

    public async play() {
        // We can't restart a buffer source, so we need to create a new one if we hit the end
        if (this.state === PlaybackState.Stopped) {
            this.disconnectSource();
            this.makeNewSourceBuffer();
            if (this.element) {
                await this.element.play();
            } else {
                (this.source as AudioBufferSourceNode).start();
            }
        }

        // We use the context suspend/resume functions because it allows us to pause a source
        // node, but that still doesn't help us when the source node runs out (see above).
        await this.context.resume();
        this.clock.flagStart();
        this.emit(PlaybackState.Playing);
    }

    private disconnectSource() {
        if (this.element) return; // leave connected, we can (and must) re-use it
        this.source?.disconnect();
        this.source?.removeEventListener("ended", this.onPlaybackEnd);
    }

    private makeNewSourceBuffer() {
        if (this.element && this.source) return; // leave connected, we can (and must) re-use it

        if (this.element) {
            this.source = this.context.createMediaElementSource(this.element);
        } else {
            this.source = this.context.createBufferSource();
            this.source.buffer = this.audioBuf;
        }

        this.source.addEventListener("ended", this.onPlaybackEnd);
        this.source.connect(this.context.destination);
    }

    public async pause() {
        await this.context.suspend();
        this.emit(PlaybackState.Paused);
    }

    public async stop() {
        await this.onPlaybackEnd();
        this.clock.flagStop();
    }

    public async toggle() {
        if (this.isPlaying) await this.pause();
        else await this.play();
    }

    public async skipTo(timeSeconds: number) {
        // Dev note: this function talks a lot about clock desyncs. There is a clock running
        // independently to the audio context and buffer so that accurate human-perceptible
        // time can be exposed. The PlaybackClock class has more information, but the short
        // version is that we need to line up the useful time (clip position) with the context
        // time, and avoid as many deviations as possible as otherwise the user could see the
        // wrong time, and we stop playback at the wrong time, etc.

        timeSeconds = clamp(timeSeconds, 0, this.clock.durationSeconds);

        // Track playing state so we don't cause seeking to start playing the track.
        const isPlaying = this.isPlaying;

        if (isPlaying) {
            // Pause first so we can get an accurate measurement of time
            await this.context.suspend();
        }

        // We can't simply tell the context/buffer to jump to a time, so we have to
        // start a whole new buffer and start it from the new time offset.
        const now = this.context.currentTime;
        this.disconnectSource();
        this.makeNewSourceBuffer();

        // We have to resync the clock because it can get confused about where we're
        // at in the audio clip.
        this.clock.syncTo(now, timeSeconds);

        // Always start the source to queue it up. We have to do this now (and pause
        // quickly if we're not supposed to be playing) as otherwise the clock can desync
        // when it comes time to the user hitting play. After a couple jumps, the user
        // will have desynced the clock enough to be about 10-15 seconds off, while this
        // keeps it as close to perfect as humans can perceive.
        if (this.element) {
            this.element.currentTime = timeSeconds;
        } else {
            (this.source as AudioBufferSourceNode).start(now, timeSeconds);
        }

        // Dev note: it's critical that the code gap between `this.source.start()` and
        // `this.pause()` is as small as possible: we do not want to delay *anything*
        // as that could cause a clock desync, or a buggy feeling as a single note plays
        // during seeking.

        if (isPlaying) {
            // If we were playing before, continue the context so the clock doesn't desync.
            await this.context.resume();
        } else {
            // As mentioned above, we'll have to pause the clip if we weren't supposed to
            // be playing it just yet. If we didn't have this, the audio clip plays but all
            // the states will be wrong: clock won't advance, pause state doesn't match the
            // blaring noise leaving the user's speakers, etc.
            //
            // Also as mentioned, if the code gap is small enough then this should be
            // executed immediately after the start time, leaving no feasible time for the
            // user's speakers to play any sound.
            await this.pause();
        }
    }
}
