import isNil = require('lodash/isNil');
import isNaN = require('lodash/isNaN');
import isObject = require('lodash/isObject');
import get = require('lodash/get');
import set = require('lodash/set');
import { isEqual } from "lodash";
import { parallel } from 'async';
import {
	RegionAttributes,
	RegionsObject,
	SMILFileObject,
	SMILVideo,
	SosModule,
	CurrentlyPlaying,
	SMILFile,
	SMILImage,
	PlaylistElement,
	SMILWidget,
	SMILMedia,
	SMILMediaNoVideo,
	SMILIntro, SosHtmlElement, TriggerList,
} from '../../models';
import { FileStructure, SMILScheduleEnum, XmlTags, HtmlEnum, SMILEnums } from '../../enums';
import { defaults as config } from '../../../config/parameters';
import { IFile, IStorageUnit } from '@signageos/front-applet/es6/FrontApplet/FileSystem/types';
import { getFileName } from '../files/tools';
import {
	debug, getRegionInfo, sleep, isNotPrefetchLoop, parseSmilSchedule,
	setElementDuration, createHtmlElement, extractAdditionalInfo, setDefaultAwait, resetBodyContent,
	generateElementId, createDomElement,
} from './tools';
import { Files } from '../files/files';
const isUrl = require('is-url-superb');

// @ts-ignore
export class Playlist {
	private checkFilesLoop: boolean = true;
	private cancelFunction: boolean = false;
	private files: Files;
	private sos: SosModule;
	// hold reference to all currently playing content in each region
	private currentlyPlaying: CurrentlyPlaying = {};
	private triggersEndless: any = {};
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
	 * Performs all necessary actions needed to process playlist ( delete unused files, extact widgets, extract regionInfo for each media )
	 * @param smilObject - JSON representation of parsed smil file
	 * @param internalStorageUnit - persistent storage unit
	 * @param smilUrl - url for SMIL file so its not deleted as unused file ( actual smil file url is not present in smil file itself )
	 */
	public manageFilesAndInfo = async (smilObject: SMILFileObject, internalStorageUnit: IStorageUnit, smilUrl: string) => {
		// check of outdated files and delete them
		await this.files.deleteUnusedFiles(internalStorageUnit, smilObject, smilUrl);

		debug('Unused files deleted');

		// unpack .wgt archives with widgets ( ref tag )
		await this.files.extractWidgets(smilObject.ref, internalStorageUnit);

		debug('Widgets extracted');

		// extracts region info for all medias in playlist
		await this.getAllInfo(smilObject.playlist, smilObject, internalStorageUnit);
		debug('All elements info extracted');

		await this.getAllInfo(smilObject.triggers, smilObject, internalStorageUnit, true);
		debug('All triggers info extracted');

		console.log(JSON.stringify(smilObject));
	}

	/**
	 * plays intro media before actual playlist starts, default behaviour is to play video as intro
	 * @param smilObject - JSON representation of parsed smil file
	 * @param internalStorageUnit - persistent storage unit
	 * @param smilUrl - url of the actual smil file
	 */
	public playIntro = async (smilObject: SMILFileObject, internalStorageUnit: IStorageUnit, smilUrl: string): Promise<void> => {
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
				// prepares everything needed for processing playlist
				if (playingIntro) {
					await this.manageFilesAndInfo(smilObject, internalStorageUnit, smilUrl);
				}
				// all files are downloaded, stop intro
				debug('SMIL media files download finished, stopping intro');
				return playingIntro = false;
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
				async (callback) => {
					// triggers processing
					await this.watchTriggers(smilObject);
					callback();
				},
				async (callback) => {
					// triggers processing
					await this.watchTriggers2(smilObject);
					callback();
				},
				async (callback) => {
					// triggers cancel
					await this.cancelTrigger();
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
	 * @param isTrigger - boolean value determining if function is processing trigger playlist or ordinary playlist
	 */
	public getAllInfo = async (
		playlist: PlaylistElement | PlaylistElement[] | TriggerList, region: SMILFileObject, internalStorageUnit: IStorageUnit,
		isTrigger: boolean = false,
	): Promise<void> => {
		let widgetRootFile: string = '';
		let fileStructure: string = '';
		let htmlElement: string = '';
		let triggerName: string = '';
		for (let [key, loopValue] of Object.entries(playlist)) {
			triggerName = key === 'begin' && loopValue.startsWith(SMILEnums.triggerFormat) ? loopValue : triggerName;
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
						widgetRootFile = HtmlEnum.widgetRoot;
						fileStructure = FileStructure.extracted;
						htmlElement = HtmlEnum.ref;
						break;
					case 'img':
						fileStructure = FileStructure.images;
						htmlElement = HtmlEnum.img;
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

						// create placeholders in DOM for images and widgets to speedup playlist processing
						if (key === 'img' || key === 'ref') {
							createDomElement(elem, htmlElement);
						}
						// element will be played only on trigger emit in nested region
						if (isTrigger) {
							elem.triggerValue = triggerName;
						}
					}
				}
			} else {
				await this.getAllInfo(value, region, internalStorageUnit, isTrigger);
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
			for (let elem of value) {
				promises.push((async () => {
					await this.processPlaylist(elem, parent, endTime);
				})());
			}
		} else {
			promises.push((async () => {
				await this.processPlaylist(value, parent, endTime);
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
		playlist: PlaylistElement | PlaylistElement[], parent: string = '', endTime: number = 0,
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
				if (Array.isArray(value)) {
					let arrayIndex = 0;
					for (const valueElement of value) {
						// skip trigger processing in automated playlist
						if (valueElement.hasOwnProperty('begin') && valueElement.begin!.startsWith(SMILEnums.triggerFormat)) {
							console.log('skipping trigger');
							continue;
						}
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
											await this.processPlaylist(valueElement, 'seq', timeToEnd);
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
									await this.processPlaylist(valueElement, 'seq', timeToEnd);
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
									await this.processPlaylist(valueElement, 'seq', endTime);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}
						promises.push((async () => {
							await this.processPlaylist(valueElement, 'seq', endTime);
						})());
					}
				} else {
					// skip trigger processing in automated playlist
					if (value.hasOwnProperty('begin') && value.begin!.startsWith(SMILEnums.triggerFormat)) {
						console.log('skipping trigger');
						continue;
					}
					if (value.hasOwnProperty('begin') && value.begin!.indexOf('wallclock') > -1) {
						const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin!, value.end);
						if (timeToEnd === SMILScheduleEnum.neverPlay) {
							return;
						}
						promises.push((async () => {
							await sleep(timeToStart);
							await this.processPlaylist(value, 'seq', timeToEnd);
						})());
					} else if (value.repeatCount === 'indefinite'
						&& value !== this.introObject
						&& isNotPrefetchLoop(value)) {
						promises.push((async () => {
							// when endTime is not set, play indefinitely
							if (endTime === 0) {
								await this.runEndlessLoop(async () => {
									await this.processPlaylist(value, 'seq', endTime);
								});
							} else {
								while (Date.now() < endTime) {
									await this.processPlaylist(value, 'seq', endTime);
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
								await this.processPlaylist(value, 'seq', endTime);
								counter += 1;
							}
						})());
						await Promise.all(promises);
					} else {
						promises.push((async () => {
							await this.processPlaylist(value, 'seq', endTime);
						})());
					}
				}
			}

			if (key === 'par') {
				for (let [parKey, parValue] of Object.entries(<object> value)) {
					if (XmlTags.extractedElements.includes(parKey)) {
						await this.playElement(parValue, parKey, parent);
						continue;
					}
					if (Array.isArray(parValue)) {
						const controlTag = parKey === 'seq' ? parKey : 'par';
						const wrapper = {
							[controlTag]: parValue,
						};
						promises.push((async () => {
							await this.processPlaylist(wrapper, 'par', endTime);
						})());
					} else {
						// skip trigger processing in automated playlist
						if (value.hasOwnProperty('begin') && value.begin!.startsWith(SMILEnums.triggerFormat)) {
							console.log('skipping trigger');
							continue;
						}
						if (value.hasOwnProperty('begin') && value.begin!.indexOf('wallclock') > -1) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin!, value.end);
							if (timeToEnd === SMILScheduleEnum.neverPlay) {
								return;
							}
							promises.push((async () => {
								await sleep(timeToStart);
								await this.processPlaylist(value, parKey, timeToEnd);
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
								await this.processPlaylist(parValue, 'par', timeToEnd);
							})());
							continue;
						}
						if (parValue.repeatCount === 'indefinite' && isNotPrefetchLoop(parValue)) {
							promises.push((async () => {
								// when endTime is not set, play indefinitely
								if (endTime === 0) {
									await this.runEndlessLoop(async () => {
										await this.processPlaylist(parValue, parKey, endTime);
									});
								} else {
									while (Date.now() < endTime) {
										await this.processPlaylist(parValue, parKey, endTime);
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
									await this.processPlaylist(parValue, 'par', endTime);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}

						promises.push((async () => {
							await this.processPlaylist(parValue, parKey, endTime);
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
				await this.playElement(<SMILMedia> value, key, parent);
			}
		}
	}

	public watchTriggers = async(smilObject: SMILFileObject) => {
		await sleep(3000);
		const testingTrigger = 'trigger3';
		console.log('startring trigger');
		const triggerMedia = smilObject.triggers[testingTrigger];
		console.log(JSON.stringify(triggerMedia));
		set(this.triggersEndless, `${testingTrigger}.play`, true);
		while (this.triggersEndless[testingTrigger].play) {
			console.log('playing trigger');
			await this.processPlaylist(triggerMedia);
		}
	}

	public watchTriggers2 = async(smilObject: SMILFileObject) => {
		await sleep(8000);
		const testingTrigger = 'trigger2';
		console.log('startring trigger2');
		const triggerMedia = smilObject.triggers[testingTrigger];
		set(this.triggersEndless, `${testingTrigger}.play`, true);
		while (this.triggersEndless[testingTrigger].play) {
			await this.processPlaylist(triggerMedia);
		}
	}

	public cancelTrigger = async() => {
		await sleep(12000);
		console.log('cancelling trigger');
		const testingTrigger = 'trigger3';
		set(this.triggersEndless, `${testingTrigger}.play`, false);
		const regionInfo = this.triggersEndless[testingTrigger].regionInfo;
		// @ts-ignore
		await this.cancelPreviousMedia(regionInfo);
	}

	private findFirstFreeRegion(regions: RegionAttributes[]): number {
		let index = 0;
		for (const region of regions) {
			if (get(this.currentlyPlaying[region.regionName], 'playing', false) === false) {
				return index;
			}
			index += 1;
		}
		return 0;
	}

	private isRegionOrNestedActive = async (regionInfo: RegionAttributes): Promise<boolean> => {
		if (get(this.currentlyPlaying[regionInfo.regionName], 'playing') === true
			&& get(this.currentlyPlaying[regionInfo.regionName], 'triggerValue', 'default') !== 'default') {
			return true;
		}

		if (regionInfo.hasOwnProperty('region')) {
			for (const region of <RegionAttributes[]> regionInfo.region) {
				if (get(this.currentlyPlaying[region.regionName], 'playing') === true) {
					return true;
				}
				// if media has set playing to false, cancel it
				if (get(this.currentlyPlaying[region.regionName], 'playing') === false) {
					console.log('canceling from nested region');
					console.log(JSON.stringify(this.currentlyPlaying[region.regionName]));
					await this.cancelPreviousMedia(region);
				}

			}
		}
		return false;
	}

	private setIntroUrl(introObject: object) {
		this.introObject = introObject;
	}

	private getCancelFunction(): boolean {
		return this.cancelFunction;
	}

	/**
	 * determines which function to use to cancel previous content
	 * @param regionInfo - information about region when current video belongs to
	 */
	private cancelPreviousMedia = async (regionInfo: RegionAttributes) => {
		switch (this.currentlyPlaying[regionInfo.regionName].media) {
			case 'video':
				await sleep(500);
				await this.cancelPreviousVideo(regionInfo);
				break;
			default:
				await sleep(200);
				this.cancelPreviousImage(regionInfo);
				break;
		}
		// remove record from currentlyPlaying object after successful cancel
		delete this.currentlyPlaying[regionInfo.regionName];
	}

	/**
	 * sets element which played in current region before currently playing element invisible ( image, widget, video )
	 * @param regionInfo - information about region when current video belongs to
	 */
	private cancelPreviousImage = (regionInfo: RegionAttributes) => {
		debug('previous html element playing: %O', this.currentlyPlaying[regionInfo.regionName]);
		if (isNil(this.currentlyPlaying[regionInfo.regionName])) {
			debug('html element was already cancelled');
			return;
		}
		const element = <HTMLElement> document.getElementById((<SosHtmlElement> this.currentlyPlaying[regionInfo.regionName]).id);
		element.style.display = 'none';
		this.currentlyPlaying[regionInfo.regionName].player = 'stop';
		this.currentlyPlaying[regionInfo.regionName].playing = false;
	}

	/**
	 * updated currentlyPlaying object with new element
	 * @param element -  element which is currently playing in given region ( video or HtmlElement )
	 * @param tag - variable which specifies type of element ( video or HtmlElement )
	 * @param regionName -  name of the region of current media
	 */
	private setCurrentlyPlaying = (element: SMILVideo | SosHtmlElement, tag: string, regionName: string) => {
		console.log('setting video to region ' + regionName);
		// @ts-ignore
		this.currentlyPlaying[regionName] = element;
		this.currentlyPlaying[regionName].media = tag;
		this.currentlyPlaying[regionName].playing = true;
	}

	/**
	 * removes video from DOM which played in current region before currently playing element ( image, widget or video )
	 * @param regionInfo - information about region when current video belongs to
	 */
	private cancelPreviousVideo = async (regionInfo: RegionAttributes) => {
		debug('previous video playing: %O', this.currentlyPlaying[regionInfo.regionName]);
		if (isNil(this.currentlyPlaying[regionInfo.regionName])) {
			debug('video was already cancelled');
			return;
		}

		this.currentlyPlaying[regionInfo.regionName].player = 'stop';

		const video = <SMILVideo> this.currentlyPlaying[regionInfo.regionName];
		let localRegionInfo = video.regionInfo;
		console.log(localRegionInfo.regionName);
		console.log(regionInfo.regionName);
		// cancelling trigger, have to find correct nested region
		if (localRegionInfo.regionName !== regionInfo.regionName) {
			localRegionInfo.region.forEach((nestedRegion: RegionAttributes) => {
				if (nestedRegion.regionName === regionInfo.regionName) {
					localRegionInfo = nestedRegion;
				}
			});
		}
		await this.sos.video.stop(
			video.localFilePath,
			localRegionInfo.left,
			localRegionInfo.top,
			localRegionInfo.width,
			localRegionInfo.height,
		);
		video.playing = false;
		debug('previous video stopped');
	}

	/**
	 * plays images, widgets and audio, creates htmlElement, appends to DOM and waits for specified duration before resolving function
	 * @param filepath - local folder structure where file is stored
	 * @param regionInfo - information about regio	n when current media belongs to
	 * @param duration - how long should media stay on screen
	 * @param triggerValue
	 */
	private playTimedMedia = async (
		filepath: string, regionInfo: RegionAttributes, duration: string, triggerValue: string | undefined,
	): Promise<string | void> => {
		return new Promise(async (resolve) => {
			let element = <HTMLElement> document.getElementById(generateElementId(filepath, regionInfo.regionName));
			// set correct duration
			const parsedDuration: number = setElementDuration(duration);

			if (element.getAttribute('src') === null) {
				element.setAttribute('src', filepath);
			}

			let localRegionInfo, parentRegion = localRegionInfo = regionInfo;

			// console.log(!video.isTrigger);
			// console.log(await this.isRegionOrNestedActive(regionInfo));
			while (isNil(triggerValue) && await this.isRegionOrNestedActive(localRegionInfo)) {
				debug('Cant play html element because its region is occupied by trigger. element: %s, region: %O', filepath, localRegionInfo);
				await sleep(1000);
			}

			if (!isNil(triggerValue) && localRegionInfo.hasOwnProperty('region')) {
				if (!Array.isArray(localRegionInfo.region)) {
					localRegionInfo.region = [localRegionInfo.region];
				}

				// if this trigger has already assigned region take it,
				// else find first free region in nested regions, if none is free, take first one
				localRegionInfo = !isNil(this.triggersEndless[triggerValue].regionInfo) ?
					this.triggersEndless[triggerValue].regionInfo : localRegionInfo.region[this.findFirstFreeRegion(localRegionInfo.region)];
				set(this.triggersEndless, `${triggerValue}.regionInfo`, localRegionInfo);

				// new coordinates for new region
				element.style.width = `${localRegionInfo.width}px`;
				element.style.height = `${localRegionInfo.height}px`;
				element.style.top = `${localRegionInfo.top}px`;
				element.style.left = `${localRegionInfo.left}px`;
			}

			element.style.display = 'block';

			const sosHtmlElement: SosHtmlElement = {
				src: <string> element.getAttribute('src'),
				id: element.id,
				triggerValue,
			};

			const response = await this.waitMediaOnScreen(localRegionInfo, parentRegion, parsedDuration, sosHtmlElement);
			resolve(response);
		});
	}

	/**
	 * pauses function execution for given duration time =  how long should media stay visible on the screen
	 * @param regionInfo - information about region when current media belongs to
	 * @param parentRegion
	 * @param duration - how long should media stay on screen
	 * @param element - displayed HTML element
	 */
	private waitMediaOnScreen = async (
		regionInfo: RegionAttributes, parentRegion: RegionAttributes, duration: number, element: SosHtmlElement,
		): Promise<string | void> => {
		// set invisible previous element in region for gapless playback if it differs from current element
		if (!isNil(this.currentlyPlaying[regionInfo.regionName])
			&& get(this.currentlyPlaying[regionInfo.regionName], 'src') !== element.src) {
			debug('cancelling media: %s from image: %s', this.currentlyPlaying[regionInfo.regionName].src, element.id);
			await this.cancelPreviousMedia(regionInfo);
		}

		// cancel if video is not same as previous one played in the parent region ( triggers case )
		if (get(this.currentlyPlaying[parentRegion.regionName], 'playing')
			&& (get(this.currentlyPlaying[parentRegion.regionName], 'src') !== element.src)) {
			console.log('cancelling from parent region');
			await this.cancelPreviousMedia(parentRegion);
		}

		this.setCurrentlyPlaying(element, 'html', regionInfo.regionName);

		debug('waiting image duration: %s from element: %s', duration, element.id);
		// pause function for how long should media stay on display screen
		// @ts-ignore
		while (duration !== 0 && get(this.currentlyPlaying, `${regionInfo.regionName}.player`) !== 'stop') {
			duration--;
			await sleep(1000);
		}
		debug('element playing finished: %O', element);

		// @ts-ignore
		if (get(this.currentlyPlaying, `${regionInfo.regionName}.player`) === 'stop') {
			return 'cancelLoop';
		}
	}

	/**
	 * plays array of videos in sequential order
	 * @param videos - array of SMILVideo objects
	 */
	private playVideosSeq = async (videos: SMILVideo[]) => {
		console.log('video SEQ called');
		// @ts-ignore
		let regionInfo, parentRegion = regionInfo = videos[0].regionInfo;

		// console.log(!video.isTrigger);
		// console.log(await this.isRegionOrNestedActive(regionInfo));
		while (await this.isRegionOrNestedActive(regionInfo) && !videos[0].hasOwnProperty('triggerValue')) {
			debug('Cant play video because its region is occupied by trigger. video: %O, region: %O', videos[0], regionInfo);
			await sleep(1000);
		}

		if (videos[0].hasOwnProperty('triggerValue') && regionInfo.hasOwnProperty('region')) {
			if (!Array.isArray(regionInfo.region)) {
				regionInfo.region = [regionInfo.region];
			}
			// find first free region in nested regions, if none is free, take first one
			console.log('found index region ' + this.findFirstFreeRegion(regionInfo.region));
			// if this trigger has already assigned region take it,
			// else find first free region in nested regions, if none is free, take first one
			regionInfo = !isNil(this.triggersEndless[<string> videos[0].triggerValue].regionInfo) ?
				this.triggersEndless[<string> videos[0].triggerValue].regionInfo : regionInfo.region[this.findFirstFreeRegion(regionInfo.region)];

			set(this.triggersEndless, `${videos[0].triggerValue}.regionInfo`, regionInfo);

		}
		console.log(regionInfo);
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
					regionInfo.left,
					regionInfo.top,
					regionInfo.width,
					regionInfo.height,
					config.videoOptions,
				);
			}
			// cancel if there was image player before
			if (get(this.currentlyPlaying[regionInfo.regionName], 'playing') && i === 0
			&& get(this.currentlyPlaying[regionInfo.regionName], 'media') === 'html') {
				await this.cancelPreviousMedia(regionInfo);
			}

			// cancel if video is not same as previous one played in the parent region ( triggers case )
			if (get(this.currentlyPlaying[parentRegion.regionName], 'playing')
				&& (get(this.currentlyPlaying[parentRegion.regionName], 'src') !== currentVideo.src
				|| parentRegion.regionName !== regionInfo.regionName)) {
				console.log('cancelling from parent region');
				await this.cancelPreviousMedia(parentRegion);
			}

			this.setCurrentlyPlaying(currentVideo, 'video', regionInfo.regionName);

			debug('Playing video current: %O', currentVideo);
			await this.sos.video.play(
				currentVideo.localFilePath,
				regionInfo.left,
				regionInfo.top,
				regionInfo.width,
				regionInfo.height,
			);

			if (previousVideo.playing &&
				previousVideo.src !== currentVideo.src) {
				debug('Stopping video previous: %O', previousVideo);
				await this.sos.video.stop(
					previousVideo.localFilePath,
					regionInfo.left,
					regionInfo.top,
					regionInfo.width,
					regionInfo.height,
				);
				previousVideo.playing = false;
			}
			debug('Preparing video next: %O', nextVideo);
			if (nextVideo.src !== currentVideo.src) {
				await this.sos.video.prepare(
					nextVideo.localFilePath,
					regionInfo.left,
					regionInfo.top,
					regionInfo.width,
					regionInfo.height,
					config.videoOptions,
				);
			}

			try {
				await this.sos.video.onceEnded(
					currentVideo.localFilePath,
					regionInfo.left,
					regionInfo.top,
					regionInfo.width,
					regionInfo.height,
				);
				debug('Playing video finished: %O', currentVideo);
			} catch (err) {
				console.log('error ty vole');
				console.log(err);
			}

			// stopped because of higher priority playlist will start to play
			if (this.currentlyPlaying[regionInfo.regionName].player === 'stop') {
				console.log('stopping video');
				await this.sos.video.stop(
					currentVideo.localFilePath,
					regionInfo.left,
					regionInfo.top,
					regionInfo.width,
					regionInfo.height,
				);
				currentVideo.playing = false;
				break;
			}

			// set playing false for last video when it finishes
			if (i === videos.length - 1) {
				currentVideo.playing = false;
			}

			// force stop video only when reloading smil file due to new version of smil
			if (this.getCancelFunction()) {
				await this.cancelPreviousMedia(regionInfo);
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
		console.log('single play video');
		debug('Playing video: %O', video);
		let regionInfo, parentRegion = regionInfo = video.regionInfo;

		// console.log(!video.isTrigger);
		// console.log(await this.isRegionOrNestedActive(regionInfo));
		while (await this.isRegionOrNestedActive(regionInfo) && !video.hasOwnProperty('triggerValue')) {
			debug('Cant play video because its region is occupied by trigger. video: %O, region: %O', video, regionInfo);
			await sleep(1000);
		}

		if (video.hasOwnProperty('triggerValue') && regionInfo.hasOwnProperty('region')) {
			if (!Array.isArray(regionInfo.region)) {
				regionInfo.region = [regionInfo.region];
			}

			// if this trigger has already assigned region take it,
			// else find first free region in nested regions, if none is free, take first one
			regionInfo = !isNil(this.triggersEndless[<string> video.triggerValue].regionInfo) ?
				this.triggersEndless[<string> video.triggerValue].regionInfo : regionInfo.region[this.findFirstFreeRegion(regionInfo.region)];

			set(this.triggersEndless, `${video.triggerValue}.regionInfo`, regionInfo);
		}

		this.setCurrentlyPlaying(video, 'video', regionInfo.regionName);

		// prepare if video is not same as previous one played
		if (get(this.currentlyPlaying[regionInfo.regionName], 'src') !== video.src) {
			debug('Preparing video: %O', video);
			await this.sos.video.prepare(
				video.localFilePath,
				regionInfo.left,
				regionInfo.top,
				regionInfo.width,
				regionInfo.height,
				config.videoOptions,
			);
		}

		// cancel if video is not same as previous one played in the same region
		if (get(this.currentlyPlaying[regionInfo.regionName], 'playing')
			&& get(this.currentlyPlaying[regionInfo.regionName], 'src') !== video.src) {
			console.log('cancelling from normal region');
			await this.cancelPreviousMedia(regionInfo);
		}

		// cancel if video is not same as previous one played in the parent region ( triggers case )
		if (get(this.currentlyPlaying[parentRegion.regionName], 'playing')
			&& get(this.currentlyPlaying[parentRegion.regionName], 'src') !== video.src) {
			console.log('cancelling from parent region');
			await this.cancelPreviousMedia(parentRegion);
		}

		console.log('playing video ' + video.localFilePath);
		await this.sos.video.play(
			video.localFilePath,
			regionInfo.left,
			regionInfo.top,
			regionInfo.width,
			regionInfo.height,
		);

		try {
			await this.sos.video.onceEnded(
				video.localFilePath,
				regionInfo.left,
				regionInfo.top,
				regionInfo.width,
				regionInfo.height,
			);
			debug('Playing video finished: %O', video);
		} catch (err) {
			console.log('error ty vole');
			console.log(err);
		}

		video.playing = false;

		// no video.stop function so one video can be played gapless in infinite loop
		// stopping is handled by cancelPreviousMedia function
		// force stop video only when reloading smil file due to new version of smil
		if (this.getCancelFunction()) {
			await this.cancelPreviousMedia(regionInfo);
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
		if (parent === 'seq') {
			debug('Playing media sequentially: %O', value);
			let response;
			for (const elem of value) {
				if (isUrl(elem.src)) {
					// widget with website url as datasource
					if (htmlElement === 'iframe' && getFileName(elem.src).indexOf('.wgt') === -1) {
						response = await this.playTimedMedia(elem.src, elem.regionInfo, elem.dur, elem.triggerValue);
						if (response === 'cancelLoop') {
							break;
						}
						continue;
					}
					if (htmlElement === 'audio') {
						await this.playAudio(elem.localFilePath);
						continue;
					}
					response = await this.playTimedMedia(elem.localFilePath, elem.regionInfo, elem.dur, elem.triggerValue);
					if (response === 'cancelLoop') {
						break;
					}
				}
			}
		}
		if (parent === 'par') {
			const promises = [];
			debug('Playing media in parallel: %O', value);
			for (const elem of value) {
				// widget with website url as datasource
				if (htmlElement === 'iframe' && getFileName(elem.src).indexOf('.wgt') === -1) {
					promises.push((async () => {
						await this.playTimedMedia(elem.src, elem.regionInfo, elem.dur, elem.triggerValue);
					})());
					continue;
				}
				promises.push((async () => {
					if (htmlElement === 'audio') {
						await this.playAudio(elem.localFilePath);
						return;
					}
					await this.playTimedMedia(elem.localFilePath, elem.regionInfo, elem.dur, elem.triggerValue);
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
		// in case of array elements play it in sequential order or parent is empty ( trigger case )
		if (!isNaN(parseInt(parent)) || parent === '') {
			parent = 'seq';
		}
		debug('Playing element with key: %O, value: %O', key, value);
		console.log(parent);
		switch (key) {
			case 'video':
				if (Array.isArray(value)) {
					if (parent === 'seq') {
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
			// case 'audio':
			// 	await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.audios, 'audio');
			// 	break;
			default:
				debug(`Sorry, we are out of ${key}.`);
		}
	}
}
