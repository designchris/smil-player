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
	CurrentlyPlayingPriority, SMILFile,
	PriorityObject,
} from '../../models';
import { FileStructure, SMILScheduleEnum } from '../../enums';
import { IFile, IStorageUnit } from '@signageos/front-applet/es6/FrontApplet/FileSystem/types';
import { defaults as config } from '../../config';
// @ts-ignore
import { getFileName, getRandomInt } from '../files/tools';
import {
	debug, getRegionInfo, sleep, detectPrefetchLoop, parseSmilSchedule,
	// @ts-ignore
	setDuration, extractAdditionalInfo, createHtmlElement, setDefaultAwait,
	createPriorityObject,
} from './tools';
import { Files } from '../files/files';
const isUrl = require('is-url-superb');

export class Playlist {
	private checkFilesLoop: boolean = true;
	private cancelFunction: boolean = false;
	private files: Files;
	private sos: SosModule;
	private currentVideo: any = {};
	private currentlyPlayingPriority: CurrentlyPlayingPriority = {};
	private introObject: object;

	constructor(sos: SosModule, files: Files) {
		this.sos = sos;
		this.files = files;
	}

	public setIntroUrl(introObject: object) {
		this.introObject = introObject;
	}

	public setCheckFilesLoop(checkFilesLoop: boolean) {
		this.checkFilesLoop = checkFilesLoop;
	}

	public getCancelFunction(): boolean {
		return this.cancelFunction;
	}

	public disableLoop(value: boolean) {
		this.cancelFunction = value;
	}

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

	public cancelPreviousVideo = async (regionInfo: RegionAttributes) => {
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

	// @ts-ignore
	public playTimedMedia = async (htmlElement: string, filepath: string, regionInfo: RegionAttributes, duration: number, arrayIndex: number): string => {
		let exist = false;
		let oldElement: HTMLElement | undefined;
		if (document.getElementById(getFileName(filepath)) != null) {
			exist = true;
			oldElement = <HTMLElement> document.getElementById(`${getFileName(filepath)}-${regionInfo.regionName}`);
		}
		const element: HTMLElement = createHtmlElement(htmlElement, filepath, regionInfo);

		// set corerct duration
		duration = setDuration(duration);

		debug('Creating htmlElement: %O with duration %s', element, duration);

		document.body.appendChild(element);

		if (exist && oldElement !== undefined) {
			oldElement.remove();
		}

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
			console.log('playing ' + filepath + ' ' +
				this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.stop + ' ' + arrayIndex + ' ' + duration);
			// console.log(this.currentlyPlaying[regionInfo.regionName][index].player.contentPause);
			// await sleep(this.currentlyPlaying[regionInfo.regionName][index].player.contentPause);
			// console.log(JSON.stringify(this.currentlyPlaying[regionInfo.regionName].length));
		}
		debug('element playing finished: %s', element.id);
		if (this.currentlyPlayingPriority[regionInfo.regionName][arrayIndex].player.stop) {
			return 'cancelLoop';
		}
		return 'finished';
	}

	// @ts-ignore
	public playVideosSeq = async (videos: SMILVideo[], internalStorageUnit: IStorageUnit) => {
		const index = this.currentlyPlayingPriority[videos[0].regionInfo.regionName].length - 1;
		for (let i = 0; i < videos.length; i += 1) {
			const previousVideo = videos[(i + videos.length - 1) % videos.length];
			const currentVideo = videos[i];
			const nextVideo = videos[(i + 1) % videos.length];
			const currentVideoDetails = <IFile> await this.sos.fileSystem.getFile({
				storageUnit: internalStorageUnit,
				filePath: `${FileStructure.videos}/${getFileName(currentVideo.src)}`,
			});
			const nextVideoDetails = <IFile> await this.sos.fileSystem.getFile({
				storageUnit: internalStorageUnit,
				filePath: `${FileStructure.videos}/${getFileName(nextVideo.src)}`,
			});
			const previousVideoDetails = <IFile> await this.sos.fileSystem.getFile({
				storageUnit: internalStorageUnit,
				filePath: `${FileStructure.videos}/${getFileName(previousVideo.src)}`,
			});

			currentVideo.localFilePath = currentVideoDetails.localUri;
			nextVideo.localFilePath = nextVideoDetails.localUri;
			previousVideo.localFilePath = previousVideoDetails.localUri;

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

			await this.sos.video.play(
				currentVideo.localFilePath,
				currentVideo.regionInfo.left,
				currentVideo.regionInfo.top,
				currentVideo.regionInfo.width,
				currentVideo.regionInfo.height,
			);
			if (previousVideo.playing) {
				debug('Stopping video: %O', previousVideo);
				await this.sos.video.stop(
					previousVideo.localFilePath,
					previousVideo.regionInfo.left,
					previousVideo.regionInfo.top,
					previousVideo.regionInfo.width,
					previousVideo.regionInfo.height,
				);
				previousVideo.playing = false;
			}
			await this.sos.video.prepare(
				nextVideo.localFilePath,
				nextVideo.regionInfo.left,
				nextVideo.regionInfo.top,
				nextVideo.regionInfo.width,
				nextVideo.regionInfo.height,
				config.videoOptions,
			);
			await this.sos.video.onceEnded(
				currentVideo.localFilePath,
				currentVideo.regionInfo.left,
				currentVideo.regionInfo.top,
				currentVideo.regionInfo.width,
				currentVideo.regionInfo.height,
			);

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
				await sleep(1000);
			}

			// force stop video only when reloading smil file due to new version of smil
			if (this.getCancelFunction()) {
				await this.cancelPreviousVideo(currentVideo.regionInfo);
			}
		}
	}

	public playVideosPar = async (videos: SMILVideo[], internalStorageUnit: IStorageUnit) => {
		const promises = [];
		for (let i = 0; i < videos.length; i += 1) {
			promises.push((async () => {
				await this.playVideo(videos[i], internalStorageUnit);
			})());
		}
		await Promise.all(promises);
	}

	// @ts-ignore
	public playVideo = async (video: SMILVideo, internalStorageUnit: IStorageUnit) => {
		const index = this.currentlyPlayingPriority[video.regionInfo.regionName].length - 1;
		const currentVideoDetails = <IFile> await this.files.getFileDetails(video, internalStorageUnit, FileStructure.videos);
		video.localFilePath = currentVideoDetails.localUri;
		debug('Playing video: %O', video);

		// prepare if video is not same as previous one played
		if (isNil(this.currentVideo[video.regionInfo.regionName]) ||
			get(this.currentVideo[video.regionInfo.regionName], 'src') !== video.src) {
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

		// no video.stop function so one video can be played gapless in infinite loop
		// stopping is handled by cancelPreviousVideo function
		// force stop video only when reloading smil file due to new version of smil
		if (this.getCancelFunction()) {
			await this.cancelPreviousVideo(video.regionInfo);
		}
	}

	public setupIntroVideo = async (video: SMILVideo, internalStorageUnit: IStorageUnit, region: RegionsObject) => {
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

	public playIntroVideo = async (video: SMILVideo) => {
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

	public endIntroVideo = async (video: SMILVideo) => {
		debug('Ending intro video: %O', video);
		await this.sos.video.stop(
			video.localFilePath,
			video.regionInfo.left,
			video.regionInfo.top,
			video.regionInfo.width,
			video.regionInfo.height,
		);
	}

	// @ts-ignore
	public playOtherMedia = async (
		value: any,
		// @ts-ignore
		internalStorageUnit: IStorageUnit,
		parent: string,
		// @ts-ignore
		fileStructure: string,
		htmlElement: string,
		// @ts-ignore
		widgetRootFile: string,
	) => {
		if (!Array.isArray(value)) {
			if (isNil(value.src) || !isUrl(value.src)) {
				debug('Invalid element values: %O', value);
				return;
			}
			value = [value];
		}

		const index = this.currentlyPlayingPriority[value[0].regionInfo.regionName].length - 1;

		if (parent.startsWith('seq')) {
			debug('Playing media sequentially: %O', value);
			for (let i = 0; i < value.length; i += 1) {
				if (isUrl(value[i].src)) {
					// // widget with website url as datasource
					if (htmlElement === 'iframe' && getFileName(value[i].src).indexOf('.wgt') === -1) {
						await this.playTimedMedia(htmlElement, value[i].src, value[i].regionInfo, value[i].dur, index);
						continue;
					}
					const mediaFile = <IFile> await this.sos.fileSystem.getFile({
						storageUnit: internalStorageUnit,
						filePath: `${fileStructure}/${getFileName(value[i].src)}${widgetRootFile}`,
					});
					const response = await this.playTimedMedia(htmlElement, mediaFile.localUri, value[i].regionInfo, value[i].dur, index);
					// const response = await this.playTimedMedia(htmlElement, value[i].src, value[i].regionInfo, value[i].dur, index);
					// when interupted by higher priority playlist, dont play the rest
					if (response === 'cancelLoop') {
						break;
					}
				}
			}
		}
		if (parent.startsWith('par')) {
			const promises = [];
			debug('Playing media in parallel: %O', value);
			for (let i = 0; i < value.length; i += 1) {
				// // widget with website url as datasource
				if (htmlElement === 'iframe' && getFileName(value[i].src).indexOf('.wgt') === -1) {
					promises.push((async () => {
						await this.playTimedMedia(htmlElement, value[i].src, value[i].regionInfo, value[i].dur, index);
					})());
					continue;
				}
				promises.push((async () => {
					const mediaFile = <IFile> await this.sos.fileSystem.getFile({
						storageUnit: internalStorageUnit,
						filePath: `${fileStructure}/${getFileName(value[i].src)}${widgetRootFile}`,
					});
					await this.playTimedMedia(htmlElement, mediaFile.localUri, value[i].regionInfo, value[i].dur, index);
				})());

				// await this.playTimedMedia(htmlElement, value[i].src, value[i].regionInfo, value[i].dur, index);

			}
			await Promise.all(promises);
		}
	}

	public playElement = async (value: object | any[], key: string, internalStorageUnit: IStorageUnit, parent: string) => {
		debug('Playing element with key: %O, value: %O', key, value);
		switch (key) {
			case 'video':
				if (Array.isArray(value)) {
					if (parent.startsWith('seq')) {
						await this.playVideosSeq(value, internalStorageUnit);
						break;
					}
					await this.playVideosPar(value, internalStorageUnit);
					break;
				} else {
					await this.playVideo(<SMILVideo> value, internalStorageUnit);
				}
				break;
			case 'video2':
				if (Array.isArray(value)) {
					if (parent.startsWith('seq')) {
						await this.playVideosSeq(value, internalStorageUnit);
						break;
					}
					await this.playVideosPar(value, internalStorageUnit);
					break;
				} else {
					await this.playVideo(<SMILVideo> value, internalStorageUnit);
				}
				break;
			case 'ref':
				await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.extracted, 'iframe', '/index.html');
				break;
			case 'img':
				await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.images, 'img', '');
				break;
			case 'img2':
				await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.images, 'img', '');
				break;
			// case 'audio':
			// 	await this.playOtherMedia(value, internalStorageUnit, parent, FileStructure.audios, 'audio', '');
			// 	break;
			default:
				debug(`Sorry, we are out of ${key}.`);
		}
	}

	// @ts-ignore
	public getRegionPlayElement = async (value: any, key: string, internalStorageUnit: IStorageUnit, region: RegionsObject, parent: string = '0', endTime: number = 0, priorityObject: PriorityObject | object = {}) => {
		let currentlyPlayingValue;

		// zkontrolovat jestli to neni mimo uz
		if (!isNaN(parseInt(parent))) {
			parent = 'seq';
		}
		if (Array.isArray(value)) {
			for (let i in value) {
				value[i].regionInfo = getRegionInfo(region, value[i].region);
				extractAdditionalInfo(value[i]);
			}
			currentlyPlayingValue = value[0];
		} else {
			value.regionInfo = getRegionInfo(region, value.region);
			extractAdditionalInfo(value);
			currentlyPlayingValue = value;
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

			// @ts-ignore
			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.priorityLevel < priorityObject.priorityLevel) {
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
			// @ts-ignore
			if (this.currentlyPlayingPriority[currentlyPlayingValue.regionInfo.regionName][0].priority.priorityLevel > priorityObject.priorityLevel) {
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

		await this.playElement(value, key, internalStorageUnit, parent);
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

	public processingLoop = async (
		internalStorageUnit: IStorageUnit,
		smilObject: SMILFileObject,
		smilFile: SMILFile,
	) => {
		return new Promise((resolve, reject) => {
			parallel([
				async (callback) => {
					while (this.checkFilesLoop) {
						debug('Prepare ETag check for smil media files prepared');
						const {
							fileEtagPromisesMedia: fileEtagPromisesMedia,
							fileEtagPromisesSMIL: fileEtagPromisesSMIL,
						} = await this.files.prepareETagSetup(internalStorageUnit, smilObject, smilFile);

						debug('ETag check for smil media files prepared');
						await sleep(90000);
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
					await this.runEndlessLoop(async () => {
						await this.processPlaylist(smilObject.playlist, smilObject, internalStorageUnit);
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
	// processing parsed playlist, will change in future
	// tslint:disable-next-line:max-line-length
	public processPlaylist = async (playlist: object, region: RegionsObject, internalStorageUnit: IStorageUnit, parent: string = '', endTime: number = 0, priorityObject: PriorityObject | object = {}) => {
		for (let [key, loopValue] of Object.entries(playlist)) {
			if (!isObject(loopValue)) {
				debug('Playlist element with key is not object: %O, value: %O, skipping', key, loopValue);
				continue;
			}
			let value: any = loopValue;
			debug('Processing playlist element with key: %O, value: %O', key, value);
			const promises = [];
			if (key === 'excl') {
				if (Array.isArray(value)) {
					for (let elem of value) {
						promises.push((async () => {
							await this.processPlaylist(elem, region, internalStorageUnit, 'seq', endTime, priorityObject);
						})());
					}
				} else {
					promises.push((async () => {
						await this.processPlaylist(value, region, internalStorageUnit, 'seq', endTime, priorityObject);
					})());
				}
			}

			if (key === 'priorityClass') {
				if (Array.isArray(value)) {
					let arrayIndex = value.length - 1;
					for (let elem of value) {
						priorityObject = createPriorityObject(elem, arrayIndex);
						promises.push((async () => {
							await this.processPlaylist(elem, region, internalStorageUnit, 'seq', endTime, priorityObject);
						})());
						arrayIndex -= 1;
					}
				} else {
					priorityObject = createPriorityObject(value, 0);
					promises.push((async () => {
						await this.processPlaylist(value, region, internalStorageUnit, 'seq', endTime, priorityObject);
					})());
				}
			}

			if (key === 'seq') {
				const newParent = `seq-${getRandomInt(100000)}`;
				if (Array.isArray(value)) {
					let arrayIndex = 0;
					for (const elem of value) {
						if (elem.hasOwnProperty('begin') && elem.begin.indexOf('wallclock') > -1
							&& !isEqual(elem, this.introObject)
							&& detectPrefetchLoop(elem)) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(elem.begin, elem.end);
							// if no playable element was found in array, set defaultAwait for last element to avoid infinite loop
							if (arrayIndex === value.length - 1 && setDefaultAwait(value) === SMILScheduleEnum.defaultAwait) {
								debug('No active sequence find in wallclock schedule, setting default await: %s', SMILScheduleEnum.defaultAwait);
								await sleep(SMILScheduleEnum.defaultAwait);
							}

							if (timeToEnd === SMILScheduleEnum.neverPlay) {
								arrayIndex += 1;
								continue;
							}

							if (elem.hasOwnProperty('repeatCount') && elem.repeatCount !== 'indefinite') {
								const repeatCount = elem.repeatCount;
								let counter = 0;
								if (timeToStart <= 0) {
									promises.push((async () => {
										await sleep(timeToStart);
										while (counter < repeatCount) {
											await this.processPlaylist(elem, region, internalStorageUnit, newParent, timeToEnd, priorityObject);
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
									await this.processPlaylist(elem, region, internalStorageUnit, newParent, timeToEnd, priorityObject);
								})());
							}
							await Promise.all(promises);
							arrayIndex += 1;
							continue;
						}

						if (elem.hasOwnProperty('repeatCount') && elem.repeatCount !== 'indefinite') {
							const repeatCount = elem.repeatCount;
							let counter = 0;
							promises.push((async () => {
								while (counter < repeatCount) {
									await this.processPlaylist(elem, region, internalStorageUnit, newParent, endTime, priorityObject);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}
						promises.push((async () => {
							await this.processPlaylist(elem, region, internalStorageUnit, newParent, endTime, priorityObject);
						})());
					}
				} else {
					if (value.hasOwnProperty('begin') && value.begin.indexOf('wallclock') > -1) {
						const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin, value.end);
						if (timeToEnd === SMILScheduleEnum.neverPlay) {
							return;
						}
						promises.push((async () => {
							await sleep(timeToStart);
							await this.processPlaylist(value, region, internalStorageUnit, newParent, timeToEnd, priorityObject);
						})());
					} else if (value.repeatCount === 'indefinite'
						&& value !== this.introObject
						&& detectPrefetchLoop(value)) {
						promises.push((async () => {
							// when endTime is not set, play indefinitely
							if (endTime === 0) {
								await this.runEndlessLoop(async () => {
									await this.processPlaylist(value, region, internalStorageUnit, newParent, endTime, priorityObject);
								});
							} else {
								while (Date.now() < endTime) {
									await this.processPlaylist(value, region, internalStorageUnit, newParent, endTime, priorityObject);
									if (this.getCancelFunction()) {
										return;
									}
								}
							}
						})());
					} else if (value.hasOwnProperty('repeatCount') && value.repeatCount !== 'indefinite') {
						const repeatCount = value.repeatCount;
						let counter = 0;
						promises.push((async () => {
							while (counter < repeatCount) {
								await this.processPlaylist(value, region, internalStorageUnit, newParent, endTime, priorityObject);
								counter += 1;
							}
						})());
						await Promise.all(promises);
					} else {
						promises.push((async () => {
							await this.processPlaylist(value, region, internalStorageUnit, newParent, endTime, priorityObject);
						})());
					}
				}
			}

			if (key === 'par') {
				for (let [parKey, parValue] of Object.entries(<object> value)) {
					const newParent = `${parKey}-${getRandomInt(100000)}`;
					if (config.constants.extractedElements.includes(parKey)) {
						await this.getRegionPlayElement(parValue, parKey, internalStorageUnit, region, 'par', endTime, priorityObject);
						continue;
					}
					if (Array.isArray(parValue)) {
						// const controlTag = parKey === 'seq' ? `${parKey}-${getRandomInt(100000)}` : `par-${getRandomInt(100000)}`;
						const controlTag = parKey === 'seq' ? parKey : `par`;
						const wrapper = {
							[controlTag]: parValue,
						};
						promises.push((async () => {
							await this.processPlaylist(wrapper, region, internalStorageUnit, 'par', endTime, priorityObject);
						})());
					} else {
						if (value.hasOwnProperty('begin') && value.begin.indexOf('wallclock') > -1) {
							const {timeToStart, timeToEnd} = parseSmilSchedule(value.begin, value.end);
							if (timeToEnd === SMILScheduleEnum.neverPlay) {
								return;
							}
							promises.push((async () => {
								await sleep(timeToStart);
								await this.processPlaylist(value, region, internalStorageUnit, 'par', timeToEnd, priorityObject);
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
								await this.processPlaylist(parValue, region, internalStorageUnit, 'par', timeToEnd, priorityObject);
							})());
							continue;
						}
						if (parValue.repeatCount === 'indefinite' && detectPrefetchLoop(parValue)) {
							promises.push((async () => {
								// when endTime is not set, play indefinitely
								if (endTime === 0) {
									await this.runEndlessLoop(async () => {
										await this.processPlaylist(parValue, region, internalStorageUnit, newParent, endTime, priorityObject);
									});
								} else {
									while (Date.now() < endTime) {
										await this.processPlaylist(parValue, region, internalStorageUnit, newParent, endTime, priorityObject);
										if (this.getCancelFunction()) {
											return;
										}
									}
								}
							})());
							continue;
						}

						if (parValue.hasOwnProperty('repeatCount') && parValue.repeatCount !== 'indefinite') {
							const repeatCount = parValue.repeatCount;
							let counter = 0;
							promises.push((async () => {
								while (counter < repeatCount) {
									await this.processPlaylist(parValue, region, internalStorageUnit, newParent, endTime, priorityObject);
									counter += 1;
								}
							})());
							await Promise.all(promises);
							continue;
						}

						promises.push((async () => {
							await this.processPlaylist(parValue, region, internalStorageUnit, newParent, endTime, priorityObject);
						})());
					}
				}
			}

			await Promise.all(promises);

			if (config.constants.extractedElements.includes(key)
				&& value !== get(this.introObject, 'video', 'default')
			) {
				await this.getRegionPlayElement(value, key, internalStorageUnit, region, parent, endTime, priorityObject);
			}
		}
	}
}

// (async () => {
// 	const player = new Playlist();
// 	const playlist = {
// 		"region": {
// 			"video": {
// 				"regionName": "video",
// 				"left": "0",
// 				"top": "0",
// 				"width": "1280",
// 				"height": "720",
// 				"z-index": "1",
// 				"backgroundColor": "#FFFFFF",
// 				"mediaAlign": "topLeft",
// 			},
// 			"topOverlay": {
// 				"regionName": "topOverlay",
// 				"left": "0",
// 				"top": "0",
// 				"width": "1920",
// 				"height": "68",
// 				"z-index": "9",
// 				"backgroundColor": "transparent",
// 			},
// 			"bottomWidget": {
// 				"regionName": "bottomWidget",
// 				"left": "0",
// 				"bottom": "0",
// 				"width": "1280",
// 				"height": "360",
// 				"z-index": "1",
// 				"backgroundColor": "transparent",
// 			},
// 			"topRightWidget": {
// 				"regionName": "topRightWidget",
// 				"left": "1280",
// 				"top": "0",
// 				"width": "640",
// 				"height": "506",
// 				"z-index": "1",
// 				"backgroundColor": "transparent",
// 			},
// 			"bottomRightWidget": {
// 				"regionName": "bottomRightWidget",
// 				"left": "1280",
// 				"top": "506",
// 				"width": "640",
// 				"height": "574",
// 				"z-index": "1",
// 				"backgroundColor": "transparent",
// 			},
// 		},
// 		"rootLayout": {
// 			"width": "1920",
// 			"height": "1080",
// 			"backgroundColor": "#FFFFFF",
// 			"top": "0",
// 			"left": "0",
// 		},
// 		"playlist": {
// 			"systemComponent": "http://www.w3.org/1999/xhtml",
// 			"style": "background-color:#FFFFFF",
// 			"par": {
// 				"seq": [
// 					{
// 						"end": "__prefetchEnd.endEvent",
// 						"seq": {
// 							"repeatCount": "indefinite",
// 							"video": {
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/loader.mp4",
// 							},
// 						},
// 					},
// 					{
// 						"prefetch": [
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_1.mp4",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_2.mp4",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_1.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_2.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_3.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_4.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_5.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_7.jpg",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/widget_image_1.png",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/widget_image_2.png",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/topOverlay.wgt",
// 							},
// 							{
// 								"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/bottomWidget.wgt",
// 							},
// 						],
// 						"seq": {
// 							"id": "__prefetchEnd",
// 							"dur": "1s",
// 						},
// 					},
// 				],
// 				"par": {
// 					"begin": "__prefetchEnd.endEvent",
// 					"repeatCount": "indefinite",
// 					"excl": {
// 						"repeatCount": "indefinite",
// 						"priorityClass": [
// 							{
// 								"lower": "never",
// 								"peer": "stop",
// 								"higher": "stop",
// 								"par": {
// 									"begin": "wallclock(R/2011-01-01T01:00:00/P1D)",
// 									"end": "wallclock(R/2011-01-01T23:55:00/P1D)",
// 									"seq": {
// 										"repeatCount": "indefinite",
// 										"excl": {
// 											"begin": "0",
// 											"repeatCount": "indefinite",
// 											"priorityClass": {
// 												"higher": "stop",
// 												"pauseDisplay": "hide",
// 												"lower": "defer",
// 												"par": {
// 													"begin": "wallclock(R/2011-01-01T10:24:00/P1D)",
// 													"end": "wallclock(R/2011-01-01T10:50:00/P1D)",
// 													"seq": {
// 														"repeatCount": "indefinite",
// 														"video": [
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_1.mp4",
// 																"id": "annons0",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_2.mp4",
// 																"id": "annons0",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 														],
// 														"img": [
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_1.jpg",
// 																"id": "annons1",
// 																"dur": "5s",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_2.jpg",
// 																"id": "annons1",
// 																"dur": "5s",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_3.jpg",
// 																"id": "annons1",
// 																"dur": "5s",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_4.jpg",
// 																"id": "annons1",
// 																"dur": "5s",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 															{
// 																"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_5.jpg",
// 																"id": "annons1",
// 																"dur": "5s",
// 																"fit": "hidden",
// 																"region": "video",
// 																"param": {
// 																	"name": "cacheControl",
// 																	"value": "auto",
// 																},
// 															},
// 														],
// 													},
// 												},
// 											},
// 										},
// 									},
// 								},
// 							},
// 							{
// 								"lower": "never",
// 								"peer": "stop",
// 								"higher": "stop",
// 								"par": {
// 									"begin": "wallclock(R/2011-01-01T00:00:00/P1D)",
// 									"end": "wallclock(R/2011-01-01T23:59:59/P1D)",
// 									"seq": {
// 										"begin": "0",
// 										"dur": "indefinite",
// 										"ref": {
// 											"dur": "indefinite",
// 											"src": "adapi:blankScreen",
// 										},
// 									},
// 								},
// 							},
// 						],
// 					},
// 				},
// 			},
// 		},
// 		"video": [
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/loader.mp4",
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_1.mp4",
// 				"id": "annons0",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/video_2.mp4",
// 				"id": "annons0",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 		],
// 		"img": [
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_1.jpg",
// 				"id": "annons1",
// 				"dur": "5s",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_2.jpg",
// 				"id": "annons1",
// 				"dur": "5s",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_3.jpg",
// 				"id": "annons1",
// 				"dur": "5s",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_4.jpg",
// 				"id": "annons1",
// 				"dur": "5s",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 			{
// 				"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/img_5.jpg",
// 				"id": "annons1",
// 				"dur": "5s",
// 				"fit": "hidden",
// 				"region": "video",
// 				"param": {
// 					"name": "cacheControl",
// 					"value": "auto",
// 				},
// 			},
// 		],
// 		"ref": [
// 			{
// 				"dur": "indefinite",
// 				"src": "adapi:blankScreen",
// 			},
// 		],
// 		"audio": [],
// 		"intro": [
// 			{
// 				"repeatCount": "indefinite",
// 				"video": {
// 					"src": "https://signageos-demo.s3.eu-central-1.amazonaws.com/smil/zones/files/loader.mp4",
// 				},
// 			},
// 		],
// 	};
//
// 	const storage = {
// 		type: '',
// 		capacity: 0,
// 		freeSpace: 0,
// 		usableSpace: 0,
// 		removable: true,
// 	};
// 	player.setIntroUrl(playlist.intro[0]);
// 	await player.processPlaylist(playlist.playlist, playlist, storage);
// })();
