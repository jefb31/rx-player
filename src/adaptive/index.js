/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Subscription } from "rxjs/Subscription";
import { BehaviorSubject } from "rxjs/BehaviorSubject";
import { combineLatest } from "rxjs/observable/combineLatest";
import { only } from "../utils/rx-utils";
import { findBetterMatchIndex } from "../utils/languages";

import AverageBitrate from "./average-bitrate";

const DEFAULTS = {
  defaultAudioTrack: {
    language: "fra",
    audioDescription: false,
  },
  defaultTextTrack: null,
  // default buffer size in seconds
  defaultBufferSize: 30,
  // buffer threshold ratio used as a lower bound
  // margin to find the suitable representation
  defaultBufferThreshold: 0.3,
  initialVideoBitrate: 0,
  initialAudioBitrate: 0,
  maxVideoBitrate: Infinity,
  maxAudioBitrate: Infinity,
};

/**
 * Simple find function implementation.
 * @param {Array} array
 * @param {Function} predicate - The predicate. Will take as arguments:
 *   1. the current array element
 *   2. the array index
 *   3. the entire array
 * @returns {*} - null if not found
 */
function find(array, predicate) {
  for (let i = 0; i < array.length; i++) {
    if (predicate(array[i], i, array) === true) {
      return array[i];
    }
  }
  return null;
}

/**
 * Returns val if x is either not a Number type or inferior or equal to 0.
 * @param {Number} [x]
 * @param {*} val
 * @returns {*}
 */
function def(x, val) {
  return typeof x == "number" && x > 0 ? x : val;
}

/**
 * Get closest bitrate lower or equal to the bitrate wanted when the threshold
 * is equal to 0. You can add a security margin by setting the threshold between
 * 0 and 1.
 * @param {Array.<Number>} bitrates - all available bitrates.
 * @param {Number} btr - a chosen bitrate
 * @param {Number} [treshold=0]
 * @returns {Number}
 */
function getClosestBitrate(bitrates, btr, threshold=0) {
  for (let i = bitrates.length - 1; i >= 0; i--) {
    if ((bitrates[i] / btr) <= (1 - threshold)) {
      return bitrates[i];
    }
  }
  return bitrates[0];
}

/**
 * Get the highest bitrate from the representations having a width immediately
 * superior or equal to the given one.
 * @param {Array.<Object>} representations - The representations array
 * @param {Number} width
 * @returns {Number}
 */
function getMaxUsefulBitrateforWidth(representations, width) {
  const sortedRepsByWidth = representations.sort((a, b) => a.width - b.width);
  const maxWidth = sortedRepsByWidth.find(r => r.width >= width);

  if (maxWidth) {
    const filteredAdaptations = representations.filter(r => r.width <= maxWidth);
    if (filteredAdaptations.length) {
      return filteredAdaptations[filteredAdaptations.length - 1].bitrate;
    } else {
      return representations[0];
    }
  }

  return Infinity;
}

/**
 * Find first adaptation with the corresponding language.
 * @param {Array.<Object>} adaptations
 * @param {string} language
 * @returns {Object|null}
 */
function findAdaptationByLang(adaptations, language) {
  const languages = adaptations.map(a => a.language);

  const index = findBetterMatchIndex(languages, language);
  if (index >= 0) {
    return adaptations[index];
  }
  return null;
}

/**
 * @param {Array.<Object>} adaptations
 * @param {string} language
 * @param {Boolean} [audioDescription=false]
 * @returns {Object|null}
 */
function findAudioAdaptation(adaptations, language, audioDescription = false) {
  const filteredAdaptations = adaptations.filter(adaptation =>
    adaptation.isAudioDescription == audioDescription
  );
  return findAdaptationByLang(filteredAdaptations, language);
}

/**
 * @param {Array.<Object>} adaptations
 * @param {string} language
 * @param {Boolean} [closedCaption=false]
 * @returns {Object|null}
 */
function findTextAdaptation(adaptations, language, closedCaption = false) {
  const filteredAdaptations = adaptations.filter(adaptation =>
    adaptation.isClosedCaption == closedCaption
  );
  return findAdaptationByLang(filteredAdaptations, language);
}

/**
 * Filter the given observable/array to only keep the item with the selected
 * type.
 * @param {Observable|Array.<Object>} stream
 * @param {string} selectedType
 * @returns {Observable|Array.<Object>}
 */
function filterByType(stream, selectedType) {
  return stream.filter(({ type }) => type === selectedType);
}

export default function(metrics, deviceEvents, options={}) {
  Object.keys(options).forEach(key =>
    options[key] === undefined && delete options[key]
  );

  const {
    defaultAudioTrack,
    defaultTextTrack,
    defaultBufferSize,
    defaultBufferThreshold,
    initialVideoBitrate,
    initialAudioBitrate,
    maxVideoBitrate,
    maxAudioBitrate,
    limitVideoWidth,
    throttleWhenHidden,
  } = Object.assign({}, DEFAULTS, options);

  const { videoWidth, inBackground } = deviceEvents;

  const $languages = new BehaviorSubject(defaultAudioTrack);
  const $subtitles = new BehaviorSubject(defaultTextTrack);

  const $averageBitrates = {
    audio: new BehaviorSubject(initialAudioBitrate),
    video: new BehaviorSubject(initialVideoBitrate),
  };

  const averageBitratesConns = [
    AverageBitrate(filterByType(metrics, "audio"), { alpha: 0.6 })
      .multicast($averageBitrates.audio),
    AverageBitrate(filterByType(metrics, "video"), { alpha: 0.6 })
      .multicast($averageBitrates.video),
  ];

  let conns = new Subscription();
  averageBitratesConns.forEach((a) => conns.add(a.connect()));

  const $usrBitrates = {
    audio: new BehaviorSubject(Infinity),
    video: new BehaviorSubject(Infinity),
  };

  const $maxBitrates = {
    audio: new BehaviorSubject(maxAudioBitrate),
    video: new BehaviorSubject(maxVideoBitrate),
  };

  const $bufSizes = {
    audio: new BehaviorSubject(defaultBufferSize),
    video: new BehaviorSubject(defaultBufferSize),
    text:  new BehaviorSubject(defaultBufferSize),
  };

  /**
   * Returns an Observable emitting:
   *   - first, the current audio adaption
   *   - the new one each time it changes
   * @param {Array.<Object>} adaptations - The available audio adaptations
   * objects.
   * @returns {Observable}
   */
  function audioAdaptationChoice(adaptations) {
    return $languages.distinctUntilChanged()
      .map(({ language, audioDescription }) =>
        findAudioAdaptation(
          adaptations,
          language,
          audioDescription
        ) || adaptations[0]
      );
  }

  /**
   * Returns an Observable emitting:
   *   - first, the current text adaption
   *   - the new one each time it changes
   * @param {Array.<Object>} adaptations - The available text adaptations
   * objects.
   * @returns {Observable}
   */
  function textAdaptationChoice(adaptations) {
    return $subtitles.distinctUntilChanged()
      .map(arg =>
        arg ? findTextAdaptation(
          adaptations,
          arg.language,
          arg.closedCaption
        ) : null
      );
  }

  /**
   * Get the current and new adaptations each time it changes for all
   * types.
   * Mostly useful for audio languages and text subtitles to know which one
   * to choose first and when it changes.
   * @param {string} type - The adaptation type
   * @param {Array.<Object>} adaptations
   * @returns {Observable}
   */
  function getAdaptationsChoice(type, adaptations) {
    if (type == "audio") {
      return audioAdaptationChoice(adaptations);
    }

    if (type == "text") {
      return textAdaptationChoice(adaptations);
    }

    return only(adaptations[0]);
  }

  /**
   * Returns an object containing two observables:
   *   - representations: the chosen best representation for the adaptation
   *     (correlated from the user, max and average bitrates)
   *   - bufferSizes: the bufferSize chosen
   * @param {Object} adaptation
   * @returns {Object}
   */
  function getBufferAdapters(adaptation) {
    const { type, representations } = adaptation;
    const bitrates = adaptation.getAvailableBitrates();

    let representationsObservable;
    if (representations.length > 1) {
      const usrBitrates = $usrBitrates[type];
      let maxBitrates = $maxBitrates[type];

      const avrBitrates = $averageBitrates[type]
        .map((avrBitrate, count) => {
          // no threshold for the first value of the average bitrate
          // stream corresponding to the selected initial video bitrate
          let bufThreshold;
          if (count === 0) {
            bufThreshold = 0;
          } else {
            bufThreshold = defaultBufferThreshold;
          }

          return getClosestBitrate(bitrates, avrBitrate, bufThreshold);
        })
        .distinctUntilChanged()
        .debounceTime(2000)
        .startWith(getClosestBitrate(bitrates, $averageBitrates[type].getValue(), 0));

      if (type == "video") {
        // To compute the bitrate upper-bound for video
        // representations we need to combine multiple stream:
        //   - user-based maximum bitrate (subject)
        //   - maximum based on the video element width
        //   - maximum based on the application visibility (background tab)
        maxBitrates = combineLatest([maxBitrates, videoWidth, inBackground])
          .map(([maxSetBitrate, width, isHidden]) => {
            if (throttleWhenHidden && isHidden) {
              return bitrates[0];
            }

            const maxUsableBitrate = limitVideoWidth ?
              getMaxUsefulBitrateforWidth(representations, width) :
              bitrates[bitrates.length - 1];

            return Math.min(maxUsableBitrate, maxSetBitrate);
          });
      }

      representationsObservable = combineLatest(
        usrBitrates,
        maxBitrates,
        avrBitrates,
        (usr, max, avr) => {
          let btr;
          if (usr < Infinity) {
            btr = usr;
          } else if (max < Infinity) {
            btr = Math.min(max, avr);
          } else {
            btr = avr;
          }
          return find(representations, (rep) => rep.bitrate === getClosestBitrate(bitrates, btr));
        })
        .distinctUntilChanged((a, b) => a.id === b.id);
    }
    else { // representations.length <= 1
      representationsObservable = only(representations[0]);
    }

    return {
      representations: representationsObservable,
      bufferSizes: $bufSizes[type] || new BehaviorSubject(defaultBufferSize),
    };
  }

  return {
    setAudioTrack(track) { $languages.next(track); },
    setTextTrack(track)  { $subtitles.next(track); },
    getAudioTrack()      { return $languages.getValue(); },
    getTextTrack()       { return $subtitles.getValue(); },

    getAverageBitrates() { return $averageBitrates; },

    getAudioMaxBitrate() { return $maxBitrates.audio.getValue(); },
    getVideoMaxBitrate() { return $maxBitrates.video.getValue(); },
    getAudioBufferSize() { return $bufSizes.audio.getValue(); },
    getVideoBufferSize() { return $bufSizes.video.getValue(); },

    setAudioBitrate(x)    { $usrBitrates.audio.next(def(x, Infinity)); },
    setVideoBitrate(x)    { $usrBitrates.video.next(def(x, Infinity)); },
    setAudioMaxBitrate(x) { $maxBitrates.audio.next(def(x, Infinity)); },
    setVideoMaxBitrate(x) { $maxBitrates.video.next(def(x, Infinity)); },
    setAudioBufferSize(x) { $bufSizes.audio.next(def(x, defaultBufferSize)); },
    setVideoBufferSize(x) { $bufSizes.video.next(def(x, defaultBufferSize)); },

    getBufferAdapters,
    getAdaptationsChoice,

    unsubscribe() {
      if (conns) {
        conns.unsubscribe();
        conns = null;
      }
    },
  };
}
