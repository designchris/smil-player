import isNil = require('lodash/isNil');
import isNaN = require('lodash/isNaN');
import isObject = require('lodash/isObject');
import get = require('lodash/get');
import { isEqual } from "lodash";
import { parallel } from 'async';
import {
	RegionAttributes,
	RegionsObject,
	SMILFileObject,
	SMILVideo,
	SosModule,
	CurrentlyPlayingPriority,
	PriorityObject,
	SMILFile,
	SMILImage,
	PlaylistElement,
	SMILWidget,
	SMILMedia,
	SMILMediaNoVideo,
	SMILIntro, TriggerList,
} from '../../models';
import { FileStructure, SMILScheduleEnum, XmlTags } from '../../enums';
import { defaults as config } from '../../../config/parameters';
import { IFile, IStorageUnit } from '@signageos/front-applet/es6/FrontApplet/FileSystem/types';
import { getFileName, getRandomInt } from '../files/tools';
import {
	debug, getRegionInfo, sleep, isNotPrefetchLoop, parseSmilSchedule,
	setElementDuration, createHtmlElement, extractAdditionalInfo, setDefaultAwait, resetBodyContent,
	generateElementId, getStringToIntDefault, createPriorityObject,
} from './tools';
import { Files } from '../files/files';
const isUrl = require('is-url-superb');

export class Playlist {
	private checkFilesLoop: boolean = true;
	private cancelFunction: boolean = false;
	private files: Files;
	private sos: SosModule;
	// hold reference to all currently playing content in each region
	private currentVideo: any = {};
	private currentlyPlayingPriority: CurrentlyPlayingPriority = {};
	private introObject: object;

	constructor(sos: SosModule, files: Files) {
		this.sos = sos;
		this.files = files;
	}

	public setCheckFilesLoop(checkFilesLoop: boolean) {
		this.checkFilesLoop = checkFilesLoop;
	}

	// disables endless loop for media playing
	public disableLoop(value: boolean) {
		this.cancelFunction = value;
	}

	/**
	 * runs function given as parameter in endless loop
	 * @param fn - Function
	 */
	public runEndlessLoop = async (fn: Function) => {
		while (!this.cancelFunction) {
			try {
				await fn();
			} catch (err) {
				debug('Error: %O occured during processing function %s', err, fn.name);
				throw err;
			}
		}
	}

	/**
	 * plays intro media before actual playlist starts, default behaviour is to play video as intro
	 * @param smilObject - JSON representation of parsed smil file
	 * @param internalStorageUnit - persistent storage unit
	 */
	public playIntro = async (smilObject: SMILFileObject, internalStorageUnit: IStorageUnit): Promise<void> => {
		let media: string = 'video';
		let fileStructure: string = FileStructure.videos;
		let playingIntro = true;
		let downloadPromises: Promise<Function[]>[] = [];

		// play image
		if (smilObject.intro[0].hasOwnProperty('img')) {
			media = 'img';
			fileStructure = FileStructure.images;
		}

		downloadPromises = downloadPromises.concat(
			await this.files.parallelDownloadAllFiles(internalStorageUnit, [smilObject.intro[0][media]], fileStructure),
		);

		await Promise.all(downloadPromises);

		const intro: SMILIntro = smilObject.intro[0];

		switch (media) {
			case 'img':
				await this.setupIntroImage(intro.img!, internalStorageUnit, smilObject);
				break;
			default:
				await this.setupIntroVideo(intro.video!, internalStorageUnit, smilObject);
		}

		debug('Intro video downloaded: %O', intro);

		downloadPromises = await this.files.prepareDownloadMediaSetup(internalStorageUnit, smilObject);

		while (playingIntro) {
			debug('Playing intro');
			// set intro url in playlist to exclude it from further playing
			this.setIntroUrl(intro);

			switch (media) {
				case 'img':
					await sleep(1000);
					break;
				default:
					await this.playIntroVideo(intro.video!);
			}

			Promise.all(downloadPromises).then(async () =>  {
				// all files are downloaded, stop intro
				debug('SMIL media files download finished, stopping intro');
				playingIntro = false;
			});
		}

		switch (media) {
			case 'img':
				resetBodyContent();
				break;
			default:
				await this.endIntroVideo(intro.video!);
		}
	}

	/**
	 * main processing function of smil player, runs playlist in endless loop and periodically
	 * checks for smil and media update in parallel
	 * @param internalStorageUnit - persistent storage unit
	 * @param smilObject - JSON representation of parsed smil file
	 * @param smilFile - representation of actual SMIL file
	 */
	public processingLoop = async (
		internalStorageUnit: IStorageUnit,
		smilObject: SMILFileObject,
		smilFile: SMILFile,
	): Promise<void> => {
		return new Promise((resolve, reject) => {
			parallel([
				async (callback) => {
					while (this.checkFilesLoop) {
						debug('Prepare ETag check for smil media files prepared');
						const {
							fileEtagPromisesMedia: fileEtagPromisesMedia,
							fileEtagPromisesSMIL: fileEtagPromisesSMIL,
						} = await this.files.prepareLastModifiedSetup(internalStorageUnit, smilObject, smilFile);

						debug('Last modified check for smil media files prepared');
						await sleep(smilObject.refresh * 1000);
						debug('Checking files for changes');
						const response = await Promise.all(fileEtagPromisesSMIL);
						if (response[0].length > 0) {
							debug('SMIL file changed, restarting loop');
							this.disableLoop(true);
							this.setCheckFilesLoop(false);
						}
						await Promise.all(fileEtagPromisesMedia);
					}
					callback();
				},
				async (callback) => {
					// endless processing of smil playlist
					await this.runEndlessLoop(async () => {
						await this.processPlaylist(smilObject.playlist);
					});
					callback();
				},
			],       async (err) => {
				if (err) {
					reject(err);
				}
				resolve();
			});
		});
	}

	/**
	 * recursively traverses through playlist and gets additional info for all media  specified in smil file
	 * @param playlist - smil file playlist, set of rules which media should be played and when
	 * @param region - regions object with information about all regions
	 * @param internalStorageUnit - persistent storage unit
	 */
	public getAllInfo = async (
		playlist: PlaylistElement | PlaylistElement[] | TriggerList, region: SMILFileObject, internalStorageUnit: IStorageUnit,
	): Promise<void> => {
		let widgetRootFile = '';
		let fileStructure = '';
		for (let [key, loopValue] of Object.entries(playlist)) {
			// skip processing string values like "repeatCount": "indefinite"
			if (!isObject(loopValue)) {
				continue;
			}

			let value: PlaylistElement | PlaylistElement[] = loopValue;
			if (XmlTags.extractedElements.includes(key)) {
				debug('found %s element, getting all info', key);
				if (!Array.isArray(value)) {
					value = [value];
				}

				switch (key) {
					case 'video':
						fileStructure = FileStructure.videos;
						break;
					case 'ref':
						widgetRootFile = '/index.html';
						fileStructure = FileStructure.extracted;
						break;
					case 'img':
						fileStructure = FileStructure.images;
						break;
					case 'audio':
						fileStructure = FileStructure.audios;
						break;
					default:
						debug(`Sorry, we are out of ${key}.`);
				}

				for (const elem of value) {
					if (isUrl(elem.src)) {
						const mediaFile = <IFile> await this.sos.fileSystem.getFile({
							storageUnit: internalStorageUnit,
							filePath: `${fileStructure}/${getFileName(elem.src)}${widgetRootFile}`,
						});
						// in case of web page as widget, leave localFilePath blank
						elem.localFilePath = mediaFile ? mediaFile.localUri : '';
						elem.regionInfo = getRegionInfo(region, elem.region);
						extractAdditionalInfo(elem);
					}
				}
			} else {
				await this.getAllInfo(value, region, internalStorageUnit);
			}
		}
	}

	/**
	 * excl and priorityClass are not supported in this version, they are processed as seq tags
	 * @param value - JSON object or array of objects
	 * @param parent - superordinate element of value
	 * @param endTime - date in millis when value stops playing
	 */
	public processUnsupportedTag = (
		value: PlaylistElement | PlaylistElement[], parent: string = '', endTime: number = 0,
	): Promise<void>[] => {
		const promises: Promise<void>[] = [];
		if (Array.isArray(value)) {
			let arrayIndex = value.length - 1;
			for (let elem of value) {
				const priorityObject = createPriorityObject(elem, arrayIndex);
				promises.push((async () => {
					await this.processPlaylist(elem, parent, endTime, priorityObject);
				})());
				arrayIndex -= 1;
			}
		} else {
			const priorityObject = createPriorityObject(value, 0);
			promises.push((async () => {
				await this.processPlaylist(value, parent, endTime, priorityObject);
			})());
		}
		return promises;
	}

	/**
	 * recursive function which goes through the playlist and process supported tags
	 * is responsible for calling functions which handles actual playing of elements
	 * @param playlist - JSON representation of SMIL parsed playlist
	 * @param parent - superordinate element of value
	 * @param endTime - date in millis when value stops playing
	 */
	public processPlaylist = async (
		playlist: PlaylistElement | PlaylistElement[], parent: string = '', endTime: number = 0, priorityObject: PriorityObject | object = {},
	) => {
		for (let [key, loopValue] of Object.entries(playlist)) {
			// skips processing attributes of elements like repeatCount or wallclock
			if (!isObject(loopValue)) {
				debug('Playlist element with key: %O is not object. value: %O, skipping', key, loopValue);
				continue;
			}
			let value: PlaylistElement | PlaylistElement[] = loopValue;
			debug('Processing playlist element with key: %O, value: %O', key, value);

			let promises: Promise<void>[] = [];

			if (key === 'excl') {
				promises = this.processUnsupportedTag(value, 'seq', endTime);
			}

			if (key === 'priorityClass') {
				promises = this.processUnsupportedTag(value, 'seq', endTime);
			}

			if (key === 'seq') {
				const newParent = `seq-${getRandomInt(100000)}`;
				if (Array.isArray(value)) {
					let arrayIndex = 0;
					for (const valueElement of value) {
						if (valueElement.hasOwnProperty('begin') && valueElement.begin.indexOf('wallclock') > -1
							&& !isEqual(valueElement, this.introObject)
							&& isNotPrefetchLoop(valueElement)) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(valueElement.begin, valueElement.end);
							// if no playable element was found in array, set defaultAwait for last element to avoid infinite loop
							if (arrayIndex === value.length - 1 && setDefaultAwait(value) === SMILScheduleEnum.defaultAwait) {
								debug('No active sequence find in wallclock schedule, setting default await: %s', SMILScheduleEnum.defaultAwait);
								await sleep(SMILScheduleEnum.defaultAwait);
							}

							if (timeToEnd === SMILScheduleEnum.neverPlay || timeToEnd < Date.now()) {
								arrayIndex += 1;
								continue;
							}

							if (valueElement.hasOwnProperty('repeatCount') && valueElement.repeatCount !== 'indefinite') {
								const repeatCount = valueElement.repeatCount;
								let counter = 0;
								if (timeToStart <= 0) {
									promises.push((async () => {
										await sleep(timeToStart);
										while (counter < repeatCount) {
											await this.processPlaylist(valueElement, newParent, timeToEnd, priorityObject);
											counter += 1;
										}
									})());
								}
								await Promise.all(promises);
								arrayIndex += 1;
								continue;
							}
							// play at least one from array to avoid infinite loop
							if (value.length === 1 || timeToStart <= 0) {
								promises.push((async () => {
									await sleep(timeToStart);
									await this.processPlaylist(valueElement, newParent, timeToEnd, priorityObject);
								})());
							}
							await Promise.all(promises);
							arrayIndex += 1;
							continue;
						}

						if (valueElement.hasOwnProperty('repeatCount') && valueElement.repeatCount !== 'indefinite') {
							const repeatCount = valueElement.repeatCount;
							let counter = 0;
							promises.push((async () => {
								while (counter < repeatCount) {
									await this.processPlaylist(valueElement, newParent, endTime, priorityObject);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}
						promises.push((async () => {
							await this.processPlaylist(valueElement, newParent, endTime, priorityObject);
						})());
					}
				} else {
					if (value.hasOwnProperty('begin') && value.begin!.indexOf('wallclock') > -1) {
						const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin!, value.end);
						if (timeToEnd === SMILScheduleEnum.neverPlay) {
							return;
						}
						promises.push((async () => {
							await sleep(timeToStart);
							await this.processPlaylist(value, newParent, endTime, priorityObject);
						})());
					} else if (value.repeatCount === 'indefinite'
						&& value !== this.introObject
						&& isNotPrefetchLoop(value)) {
						promises.push((async () => {
							// when endTime is not set, play indefinitely
							if (endTime === 0) {
								await this.runEndlessLoop(async () => {
									await this.processPlaylist(value, newParent, endTime, priorityObject);
								});
							} else {
								while (Date.now() < endTime) {
									await this.processPlaylist(value, newParent, endTime, priorityObject);
									// force stop because new version of smil file was detected
									if (this.getCancelFunction()) {
										return;
									}
								}
							}
						})());
					} else if (value.hasOwnProperty('repeatCount') && value.repeatCount !== 'indefinite') {
						const repeatCount: number = <number> value.repeatCount;
						let counter = 0;
						promises.push((async () => {
							while (counter < repeatCount) {
								await this.processPlaylist(value, newParent, endTime, priorityObject);
								counter += 1;
							}
						})());
						await Promise.all(promises);
					} else {
						promises.push((async () => {
							await this.processPlaylist(value, newParent, endTime, priorityObject);
						})());
					}
				}
			}

			if (key === 'par') {
				for (let [parKey, parValue] of Object.entries(<object> value)) {
					const newParent = `${parKey}-${getRandomInt(100000)}`;
					if (XmlTags.extractedElements.includes(parKey)) {
						await this.priorityBehaviour(parValue, parKey, 'par', endTime, priorityObject);
						continue;
					}
					if (Array.isArray(parValue)) {
						const controlTag = parKey === 'seq' ? parKey : 'par';
						const wrapper = {
							[controlTag]: parValue,
						};
						promises.push((async () => {
							await this.processPlaylist(wrapper, 'par', endTime, priorityObject);
						})());
					} else {
						if (value.hasOwnProperty('begin') && value.begin!.indexOf('wallclock') > -1) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin!, value.end);
							if (timeToEnd === SMILScheduleEnum.neverPlay) {
								return;
							}
							promises.push((async () => {
								await sleep(timeToStart);
								await this.processPlaylist(value, parKey, timeToEnd, priorityObject);
							})());
							break;
						}
						if (parValue.hasOwnProperty('begin') && parValue.begin.indexOf('wallclock') > -1) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(parValue.begin, parValue.end);
							if (timeToEnd === SMILScheduleEnum.neverPlay) {
								return;
							}
							promises.push((async () => {
								await sleep(timeToStart);
								await this.processPlaylist(parValue, 'par', timeToEnd, priorityObject);
							})());
							continue;
						}
						if (parValue.repeatCount === 'indefinite' && isNotPrefetchLoop(parValue)) {
							promises.push((async () => {
								// when endTime is not set, play indefinitely
								if (endTime === 0) {
									await this.runEndlessLoop(async () => {
										await this.processPlaylist(parValue, newParent, endTime, priorityObject);
									});
								} else {
									while (Date.now() < endTime) {
										await this.processPlaylist(parValue, newParent, endTime, priorityObject);
										// force stop because new version of smil file was detected
										if (this.getCancelFunction()) {
											return;
										}
									}
								}
							})());
							continue;
						}

						if (parValue.hasOwnProperty('repeatCount') && parValue.repeatCount !== 'indefinite') {
							const repeatCount: number = parValue.repeatCount;
							let counter = 0;
							promises.push((async () => {
								while (counter < repeatCount) {
									await this.processPlaylist(parValue, newParent, endTime, priorityObject);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}

						promises.push((async () => {
							await this.processPlaylist(parValue, newParent, endTime, priorityObject);
						})());
					}
				}
			}

			await Promise.all(promises);

			// dont play intro in the actual playlist
			if (XmlTags.extractedElements.includes(key)
				&& value !== get(this.introObject, 'video', 'default')
				&& value !== get(this.introObject, 'img', 'default')
			) {
				await this.priorityBehaviour(<SMILMedia> value, key, parent, endTime, priorityObject);
			}
		}
	}

	private setIntroUrl(introObject: object) {
		this.introObject = introObject;
	}

	private getCancelFunction(): boolean {
		return this.cancelFunction;
	}

	/**
	 * removes video from DOM which played in current region before currently playing element ( image, widget or video )
	 * @param regionInfo - information about region when current video belongs to
	 */
	private cancelPreviousVideo = async (regionInfo: RegionAttributes) => {
		debug('previous video playing: %O', this.currentVideo[regionInfo.regionName]);
		try {
			await this.sos.video.stop(
				this.currentVideo[regionInfo.regionName].localFilePath,
				this.currentVideo[regionInfo.regionName].regionInfo.left,
				this.currentVideo[regionInfo.regionName].regionInfo.top,
				this.currentVideo[regionInfo.regionName].regionInfo.width,
				this.currentVideo[regionInfo.regionName].regionInfo.height,
			);
		} catch (err) {
			debug('error occurred during video stop');
		}
		this.currentVideo[regionInfo.regionName].playing = false;
		debug('previous video stopped');
	}

	/**
	 * plays images, widgets and audio, creates htmlElement, appends to DOM and waits for specified duration before resolving function
	 * @param htmlElement - which html element will be created in DOM
	 * @param filepath - local folder structure where file is stored
	 * @param regionInfo - information about region when current media belongs to
	 * @param duration - how long should media stay on screen
	 */
	private playTimedMedia = async (
		htmlElement: string, filepath: string, regionInfo: RegionAttributes, duration: string, arrayIndex: number,
	): Promise<string> => {
		return new Promise(async (resolve, reject) => {
			let oldElement = document.getElementById(generateElementId(filepath, regionInfo.regionName));
			// set correct duration
			const parsedDuration: number = setElementDuration(duration);

			if (oldElement) {
				let zIndex: number = getStringToIntDefault(oldElement.style.zIndex);
				zIndex += 1;
				console.log(zIndex);
				// oldElement.style.zIndex = String(zIndex);

				const response = await this.waitMediaOnScreen(regionInfo, parsedDuration, oldElement, arrayIndex);
				resolve(response);
			} else {
				const element: HTMLElement = createHtmlElement(htmlElement, filepath, regionInfo);
				document.body.appendChild(element);
				debug('Creating htmlElement: %O with duration %s', element, duration);

				element.onerror = (message: string) => {
					debug('Error occurred during playing element: %O with error message: %s', element, message);
					reject();
				};

				element.onload = async () => {
					const response = await this.waitMediaOnScreen(regionInfo, parsedDuration, element, arrayIndex);
					resolve(response);
				};
			}
		});
	}

	/**
	 * pauses function execution for given duration time =  how long should media stay visible on the screen
	 * @param regionInfo - information about region when current media belongs to
	 * @param duration - how long should media stay on screen
	 * @param element - displayed HTML element
	 * @param arrayIndex - position in priority array
	 */
	private waitMediaOnScreen = async (
		regionInfo: RegionAttributes, duration: number, element: HTMLElement, arrayIndex: number,
	): Promise<string> => {
		// if previous media in region was video, cancel it
		if (get(this.currentVideo[regionInfo.regionName], 'playing')) {
			console.log('cancelling video from image');
			await this.cancelPreviousVideo(regionInfo);
		}

		while (duration !== 0 && !this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.stop) {
			while (this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.contentPause !== 0) {
				// console.log('image paused');
				await sleep(1000);
			}
			duration--;
			await sleep(1000);
			console.log('playing ' + element.id + ' ' +
				this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.stop + ' ' + arrayIndex + ' ' + duration);
			// console.log(this.currentlyPlaying[regionInfo.regionName][index].player.contentPause);
			// await sleep(this.currentlyPlaying[regionInfo.regionName][index].player.contentPause);
			// console.log(JSON.stringify(this.currentlyPlaying[regionInfo.regionName].length));
		}
		debug('element playing finished: %s', element.id);
		if (this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.stop) {
			return 'cancelLoop';
		}
		debug('element playing finished: %O', element);
		return 'finished';
	}

	/**
	 * plays array of videos in sequential order
	 * @param videos - array of SMILVideo objects
	 */
	private playVideosSeq = async (videos: SMILVideo[]) => {
		const index = this.currentlyPlayingPriority[videos[0].regionInfo.regionName].length - 1;
		for (let i = 0; i < videos.length; i += 1) {
			const previousVideo = videos[(i + videos.length - 1) % videos.length];
			const currentVideo = videos[i];
			const nextVideo = videos[(i + 1) % videos.length];

			debug(
				'Playing videos in loop, currentVideo: %O,' +
				' previousVideo: %O' +
				' nextVideo: %O',
				currentVideo,
				previousVideo,
				nextVideo,
			);

			// prepare video only once ( was double prepare current and next video )
			if (i === 0) {
				debug('Preparing video current: %O', currentVideo);
				await this.sos.video.prepare(
					currentVideo.localFilePath,
					currentVideo.regionInfo.left,
					currentVideo.regionInfo.top,
					currentVideo.regionInfo.width,
					currentVideo.regionInfo.height,
					config.videoOptions,
				);
			}

			this.currentVideo[currentVideo.regionInfo.regionName] = currentVideo;
			currentVideo.playing = true;

			debug('Playing video current: %O', currentVideo);
			await this.sos.video.play(
				currentVideo.localFilePath,
				currentVideo.regionInfo.left,
				currentVideo.regionInfo.top,
				currentVideo.regionInfo.width,
				currentVideo.regionInfo.height,
			);

			if (previousVideo.playing &&
				previousVideo.src !== currentVideo.src) {
				debug('Stopping video previous: %O', previousVideo);
				await this.sos.video.stop(
					previousVideo.localFilePath,
					previousVideo.regionInfo.left,
					previousVideo.regionInfo.top,
					previousVideo.regionInfo.width,
					previousVideo.regionInfo.height,
				);
				previousVideo.playing = false;
			}
			debug('Preparing video next: %O', nextVideo);
			if (nextVideo.src !== currentVideo.src) {
				await this.sos.video.prepare(
					nextVideo.localFilePath,
					nextVideo.regionInfo.left,
					nextVideo.regionInfo.top,
					nextVideo.regionInfo.width,
					nextVideo.regionInfo.height,
					config.videoOptions,
				);
			}

			await this.sos.video.onceEnded(
				currentVideo.localFilePath,
				currentVideo.regionInfo.left,
				currentVideo.regionInfo.top,
				currentVideo.regionInfo.width,
				currentVideo.regionInfo.height,
			);
			debug('Finished playing video: %O', currentVideo);

			console.log(index);
			console.log('playing ' + currentVideo.src + ' ' +
				this.currentlyPlayingPriority[currentVideo.regionInfo.regionName][index].player.stop + ' ' + index);

			// stopped because of higher priority playlist will start to play
			if (this.currentlyPlayingPriority[currentVideo.regionInfo.regionName][index].player.stop) {
				console.log('stopping video');
				await this.sos.video.stop(
					currentVideo.localFilePath,
					currentVideo.regionInfo.left,
					currentVideo.regionInfo.top,
					currentVideo.regionInfo.width,
					currentVideo.regionInfo.height,
				);
				currentVideo.playing = false;
				break;
			}

			while (this.currentlyPlayingPriority[currentVideo.regionInfo.regionName][index].player.contentPause !== 0) {
				console.log('video paused multiple');
				await sleep(1000);
			}

			// force stop video only when reloading smil file due to new version of smil
			if (this.getCancelFunction()) {
				await this.cancelPreviousVideo(currentVideo.regionInfo);
			}
		}
	}

	/**
	 * plays videos in parallel
	 * @param videos - array of SMILVideo objects
	 */
	private playVideosPar = async (videos: SMILVideo[]) => {
		const promises = [];
		for (let elem of videos) {
			promises.push((async () => {
				await this.playVideo(elem);
			})());
		}
		await Promise.all(promises);
	}

	private playAudio = async (filePath: string) => {
		debug('Playing audio: %s', filePath);
		return new Promise((resolve, reject) => {
			const audioElement = <HTMLAudioElement> new Audio(filePath);
			audioElement.onerror = reject;
			audioElement.onended = resolve;
			audioElement.play();
		});
	}

	/**
	 * plays one video
	 * @param video - SMILVideo object
	 */
	private playVideo = async (video: SMILVideo) => {
		debug('Playing video: %O', video);
		const index = this.currentlyPlayingPriority[video.regionInfo.regionName].length - 1;
		// prepare if video is not same as previous one played
		if (get(this.currentVideo[video.regionInfo.regionName], 'src') !== video.src) {
			debug('Preparing video: %O', video);
			await this.sos.video.prepare(
				video.localFilePath,
				video.regionInfo.left,
				video.regionInfo.top,
				video.regionInfo.width,
				video.regionInfo.height,
				config.videoOptions,
			);
		}

		// cancel if video is not same as previous one played
		if (get(this.currentVideo[video.regionInfo.regionName], 'playing')
			&& get(this.currentVideo[video.regionInfo.regionName], 'src') !== video.src) {
			await this.cancelPreviousVideo(video.regionInfo);
		}

		this.currentVideo[video.regionInfo.regionName] = video;
		video.playing = true;

		await this.sos.video.play(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);

		await this.sos.video.onceEnded(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);
		debug('Playing video finished: %O', video);

		console.log('playing ' + video.src + ' ' +
			this.currentlyPlayingPriority[video.regionInfo.regionName][index].player.stop + ' ' + index);

		// stopped because of higher priority playlist will start to play
		if (this.currentlyPlayingPriority[video.regionInfo.regionName][index].player.stop) {
			await this.sos.video.stop(
				video.localFilePath,
				video.regionInfo.left,
				video.regionInfo.top,
				video.regionInfo.width,
				video.regionInfo.height,
			);
			video.playing = false;
		}

		while (this.currentlyPlayingPriority[video.regionInfo.regionName][index].player.contentPause !== 0) {
			console.log('video paused single');
			await sleep(1000);
		}

		// no video.stop function so one video can be played gapless in infinite loop
		// stopping is handled by cancelPreviousVideo function
		// force stop video only when reloading smil file due to new version of smil
		if (this.getCancelFunction()) {
			await this.cancelPreviousVideo(video.regionInfo);
		}
	}

	private setupIntroVideo = async (video: SMILVideo, internalStorageUnit: IStorageUnit, region: RegionsObject) => {
		const currentVideoDetails = <IFile> await this.files.getFileDetails(video, internalStorageUnit, FileStructure.videos);
		video.regionInfo = getRegionInfo(region, video.region);
		video.localFilePath = currentVideoDetails.localUri;
		debug('Setting-up intro video: %O', video);
		await this.sos.video.prepare(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
			config.videoOptions,
		);
		debug('Intro video prepared: %O', video);
	}

	private setupIntroImage = async (image: SMILImage, internalStorageUnit: IStorageUnit, region: RegionsObject) => {
		const currentImageDetails = <IFile> await this.files.getFileDetails(image, internalStorageUnit, FileStructure.images);
		image.regionInfo = getRegionInfo(region, image.region);
		image.localFilePath = currentImageDetails.localUri;
		debug('Setting-up intro image: %O', image);
		const element: HTMLElement = createHtmlElement('img', image.localFilePath, image.regionInfo);
		document.body.appendChild(element);
		debug('Intro image prepared: %O', element);
	}

	private playIntroVideo = async (video: SMILVideo) => {
		debug('Playing intro video: %O', video);
		await this.sos.video.play(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);
		await this.sos.video.onceEnded(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);
	}

	private endIntroVideo = async (video: SMILVideo) => {
		debug('Ending intro video: %O', video);
		await this.sos.video.stop(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);
	}

	/**
	 * iterate through array of images, widgets or audios
	 * @param value - object or array of object of type SMILAudio | SMILImage | SMILWidget
	 * @param parent - superordinate element of value
	 * @param htmlElement - which html element will be created in DOM
	 */
	private playOtherMedia = async (
		value: SMILMediaNoVideo,
		parent: string,
		htmlElement: string,
	) => {
		if (!Array.isArray(value)) {
			if (isNil(value.src) || !isUrl(value.src)) {
				debug('Invalid element values: %O', value);
				return;
			}
			value = [value];
		}

		const index = this.currentlyPlayingPriority[value[0].regionInfo.regionName].length - 1;
		let response: string = '';

		if (parent.startsWith('seq')) {
			debug('Playing media sequentially: %O', value);
			for (const elem of value) {
				if (isUrl(elem.src)) {
					// widget with website url as datasource
					if (htmlElement === 'iframe' && getFileName(elem.src).indexOf('.wgt') === -1) {
						response = await this.playTimedMedia(htmlElement, elem.src, elem.regionInfo, elem.dur, index);
						// when interrupted by higher priority playlist, dont play the rest
						if (response === 'cancelLoop') {
							break;
						}
						continue;
					}
					if (htmlElement === 'audio') {
						await this.playAudio(elem.localFilePath);
						continue;
					}
					response = await this.playTimedMedia(htmlElement, elem.localFilePath, elem.regionInfo, elem.dur, index);
					// when interrupted by higher priority playlist, dont play the rest
					if (response === 'cancelLoop') {
						break;
					}

				}
			}
		}
		if (parent.startsWith('par')) {
			const promises = [];
			debug('Playing media in parallel: %O', value);
			for (const elem of value) {
				// widget with website url as datasource
				if (htmlElement === 'iframe' && getFileName(elem.src).indexOf('.wgt') === -1) {
					promises.push((async () => {
						await this.playTimedMedia(htmlElement, elem.src, elem.regionInfo, elem.dur, index);
					})());
					continue;
				}
				promises.push((async () => {
					if (htmlElement === 'audio') {
						await this.playAudio(elem.localFilePath);
						return;
					}
					await this.playTimedMedia(htmlElement, elem.localFilePath, elem.regionInfo, elem.dur, index);
				})());
			}
			await Promise.all(promises);
		}
	}

	/**
	 * call actual playing functions for given elements
	 * @param value - json object or array of json objects of type SMILAudio | SMILImage | SMILWidget | SMILVideo
	 * @param key - defines which media will be played ( video, audio, image or widget )
	 * @param parent - superordinate element of value
	 */
	private playElement = async (
		value: SMILMedia, key: string, parent: string,
	) => {
		// in case of array elements play it in sequential order
		if (!isNaN(parseInt(parent))) {
			parent = 'seq';
		}
		debug('Playing element with key: %O, value: %O', key, value);
		switch (key) {
			case 'video':
				if (Array.isArray(value)) {
					if (parent.startsWith('seq')) {
						await this.playVideosSeq(<SMILVideo[]> value);
						break;
					}
					await this.playVideosPar(<SMILVideo[]> value);
					break;
				} else {
					await this.playVideo(<SMILVideo> value);
					break;
				}
			case 'video2':
				if (Array.isArray(value)) {
					if (parent.startsWith('seq')) {
						await this.playVideosSeq(<SMILVideo[]> value);
						break;
					}
					await this.playVideosPar(<SMILVideo[]> value);
					break;
				} else {
					await this.playVideo(<SMILVideo> value);
					break;
				}
			case 'ref':
				await this.playOtherMedia(<SMILWidget | SMILWidget[]> value, parent, 'iframe');
				break;
			case 'img':
				await this.playOtherMedia(<SMILImage | SMILImage[]> value, parent, 'img');
				break;
			case 'img2':
				await this.playOtherMedia(<SMILImage | SMILImage[]> value, parent, 'img');
				break;
			// case 'audio':
			// 	await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.audios, 'audio', '');
			// 	break;
			default:
				debug(`Sorry, we are out of ${key}.`);
		}
	}

	private priorityBehaviour = async (
		value: SMILMedia, key: string, parent: string = '0', endTime: number = 0, priorityObject: PriorityObject | object = {},
		) =>  {
		let currentlyPlayingValue;

		if (Array.isArray(value)) {
			currentlyPlayingValue = value[0];
		} else {
			currentlyPlayingValue = value;
		}

		// invalid element
		if (isNil(currentlyPlayingValue.regionInfo)) {
			return;
		}

		const infoObject = {
			media: value,
			priority: priorityObject,
			player: {
				contentPause: 0,
				stop: false,
				endTime: endTime,
				playing: true,
			},
			parent: parent,
			behaviour: '',
		};

		if (!isNil(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName])
			&& this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length > 0) {

			// if attempted to play playlsit which was stopped by higher priority, wait till end of higher priority playlist and try again
			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].parent === parent
				&& this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour === 'stop') {

				// const higherPriorityEndtime = this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][1].player.endTime;
				// console.log('sameDetected');
				// console.log(higherPriorityEndtime);
				// // higher priority playlist ended, reset currentlyPlaying behaviour
				// if (higherPriorityEndtime < Date.now()) {
				// 	this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName] = [];
				// }
				// await sleep(higherPriorityEndtime - Date.now());

				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][1].player.playing = true;

				while (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][1].player.playing) {
					console.log('play');
					await sleep(1000);
				}
				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName] = [];

				return;
			}

			// only keep info about actual and preceding playlist
			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length > 2) {
				console.log(JSON.stringify(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName]));
				console.log('------------------------------');
				console.log(JSON.stringify(value));
				console.log('shifting ' + endTime);
				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].shift();
			}

			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.priorityLevel
				// @ts-ignore
				< priorityObject.priorityLevel) {
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.higher === 'stop') {
					// stop behaviour
					console.log('waiting');
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.stop = true;
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'stop';
				}

				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.higher === 'pause') {
					// pause behaviour
					console.log('pause');
					console.log(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause);
					// this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause = endTime - Date.now();
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause = 9999999;
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'pause';
					console.log(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause);
				}
			}

			// @ts-ignore
			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.priorityLevel === priorityObject.priorityLevel
				&& this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].parent !== infoObject.parent) {
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.peer === 'never') {
					// peer priority never
					return;
				}
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.peer === 'defer') {
					console.log('defer peer');

					if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length < 2) {
						if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].parent === infoObject.parent) {
							// @ts-ignore
							this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0] = infoObject;
						} else {
							// @ts-ignore
							this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
						}
					}

					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'defer';

					while (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.playing) {
						await sleep(1000);
					}
				}
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.peer === 'stop') {
					// stop behaviour
					console.log('waiting peer');
					console.log(JSON.stringify(infoObject.media));
					console.log(JSON.stringify(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].media));
					console.log(isEqual(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].media, infoObject.media));
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.stop = true;
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'stop';
				}

				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.peer === 'pause') {
					// pause behaviour
					console.log('pause peer');
					// console.log(JSON.stringify(infoObject.media));
					// console.log(JSON.stringify(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].media));
					// console.log(isEqual(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].media, infoObject.media));
					// console.log(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause);
					// this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause = endTime - Date.now();
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause = 9999999;
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'pause';
					console.log(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause);
				}
			}

			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.priorityLevel
				// @ts-ignore
				> priorityObject.priorityLevel) {
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.lower === 'never') {
					// lower priority never
					return;
				}
				// defer behaviour
				if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.lower === 'defer') {
					console.log('defer');

					if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length < 2) {
						if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].parent === infoObject.parent) {
							// @ts-ignore
							this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0] = infoObject;
						} else {
							// @ts-ignore
							this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
						}
					}

					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour = 'defer';

					while (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.playing) {
						await sleep(1000);
					}
				}
			}

		} else {
			this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName] = [];
			// @ts-ignore
			this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
		}

		let arrayIndex: number = 0;
		for (const elem of this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName]) {
			if (isEqual(elem.media, infoObject.media)) {
				break;
			}

			// same parent of playlist, update currently playing object
			if (elem.parent === infoObject.parent) {
				// preserve behaviour of previous element from same parent
				infoObject.behaviour = elem.behaviour;
				// @ts-ignore
				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][arrayIndex] = infoObject;
				break;
			}
			// new element, new parent
			if (arrayIndex === this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length - 1) {
				// @ts-ignore
				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
			}
			arrayIndex += 1;
		}
		// if (!isEqual(this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][0], infoObject)
		// 	&& !isEqual(this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][1], infoObject)) {
		// 	// @ts-ignore
		// 	this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
		// }

		// console.log(priorityObject);
		// console.log(JSON.stringify(this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName]));

		// empty currentPlaying object, push current playlist
		// if (this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName].length < 1) {
		// 	console.log('pushing empty');
		// 	// @ts-ignore
		// 	this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName].push(infoObject);
		// }

		await this.playElement(value, key, parent);
		// console.log('waiting');
		// await sleep(3000);

		// console.log(JSON.stringify(this.currentlyPlaying[currentlyPlayingValue.regionInfo.regionName][0]));
		// only higher priority can controll behaviour
		if (!isEqual(this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].media, infoObject.media)) {
			switch (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour) {
				case 'pause':
					// pause first content
					console.log('unpause');
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.contentPause = 0;
					break;
				case 'stop':
					// pause first content
					console.log('set playing false stop');
					this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][1].player.playing = false;
					break;
				default:
					break;
			}
		}

		switch (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].behaviour) {
			case 'defer':
				// defer second content
				console.log('set playing false');
				this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].player.playing = false;
				break;
			default:
				break;
		}

		// remove currently finished playlist if there is no other priority playlist going
		if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].length === 1) {
			console.log('pop');
			this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName].pop();
		}
	}
}
