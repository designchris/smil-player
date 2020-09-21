import * as chai from 'chai';
import moment from 'moment';
import {
	getRegionInfo,
	sleep,
	parseSmilSchedule,
	extractDayInfo,
	setElementDuration,
	setDefaultAwait, extractAdditionalInfo, isNotPrefetchLoop,
	getStringToIntDefault,
} from '../../../src/components/playlist/tools';
import { formatDate, formatWeekDate, computeWaitInterval } from '../../testTools/testTools';
import { mockSMILFileParsed234 } from '../../../src/components/playlist/mock/mock234';
import { mockSMILFileTriggers } from '../../../src/components/playlist/mock/mockTriggers';
import { mockSMILFileTriggersNoTopLeft } from '../../../src/components/playlist/mock/mockTriggersNoTopLeft';
import { mockParsedNestedRegion, mockParsed234Layout, mockParsed234Region, mockParsedNestedRegionNoTopLeft } from '../../../src/components/playlist/mock/mockRegions';
import { Playlist } from '../../../src/components/playlist/playlist';
import { Files } from '../../../src/components/files/files';
import { SosModule } from '../../../src/models';
import { SMILScheduleEnum } from '../../../src/enums';

const expect = chai.expect;

describe('Playlist tools component', () => {

	describe('Playlist tools component getRegionInfo tests', () => {
		it('Should return default region for non-existing region name', () => {
			// @ts-ignore
			const response = getRegionInfo(mockSMILFileParsed234, 'InvalidRegionName');
			expect(response).to.eql(mockParsed234Layout);
		});

		it('Should return correct region for existing region name', () => {
			// @ts-ignore
			const response = getRegionInfo(mockSMILFileParsed234, 'video');
			expect(response).to.eql(mockParsed234Region);
		});

		it('Should return correct region values for nested regions', () => {
			// @ts-ignore
			const response = getRegionInfo(mockSMILFileTriggers, 'video');
			expect(response).to.eql(mockParsedNestedRegion);
		});

		it('Should return correct region values for nested regions without top and left specified', () => {
			// @ts-ignore
			const response = getRegionInfo(mockSMILFileTriggersNoTopLeft, 'video');
			expect(response).to.eql(mockParsedNestedRegionNoTopLeft);
		});
	});

	describe('Playlist tools component sleep tests', () => {
		it('Should return wait specified amount of time', async () => {
			const interval = 1000;
			const start = Date.now();
			await sleep(interval);
			const end = Date.now();
			const timeWaited = end - start;
			expect(Math.abs(interval - timeWaited)).to.be.lessThan(50);
		});
	});

	describe('Playlist tools component getStringToInt tests', () => {
		it('Should return correct values for tested strings', async () => {
			const testString = [
				'aaaa',
				'',
				'14',
				'99999',
				'50s',
				'NaN',
			];

			const intValues = [
				0,
				0,
				14,
				99999,
				50,
				0,
				0,
			];

			for (let i = 0; i < testString.length; i += 1) {
				const response = getStringToIntDefault(testString[i]);
				expect(response).to.be.equal(intValues[i]);
			}
		});
	});

	describe('Playlist tools component setDefaultAwait tests', () => {
		it('Should return correct value to await', async () => {
			const testSchedules = [[{
				'begin': 'wallclock(2022-01-01T09:00)',
				'end': 'wallclock(2022-12-01T12:00)',
				'repeatCount': '1',
				'video': [],
			}, {
				'begin': 'wallclock(2020-07-16T12:00)',
				'end': 'wallclock(2020-07-17T19:00)',
				'repeatCount': '1',
				'img': [],
			}], [{
				'begin': 'wallclock(2020-01-01T09:00)',
				'end': 'wallclock(2020-12-01T12:00)',
				'repeatCount': '1',
				'video': [],
			}, {
				'begin': 'wallclock(2020-07-16T12:00)',
				'end': 'wallclock(2020-07-17T19:00)',
				'repeatCount': '1',
				'img': [],
			}], [{
				'begin': 'wallclock(2022-01-01T09:00)',
				'end': 'wallclock(2022-12-01T12:00)',
				'repeatCount': '1',
				'video': [],
			}, {
				'begin': 'wallclock(2022-07-16T12:00)',
				'end': 'wallclock(2022-07-17T19:00)',
				'repeatCount': '1',
				'img': [],
			}], [{
				'begin': 'wallclock(2022-01-01T09:00)',
				'end': 'wallclock(2022-12-01T12:00)',
				'repeatCount': '1',
				'video': [],
			}, {
				'begin': 'wallclock(2020-07-16T12:00)',
				'end': 'wallclock(2020-12-17T19:00)',
				'repeatCount': '1',
				'img': [],
			}]];

			const awaitTimes = [
				SMILScheduleEnum.defaultAwait,
				0,
				SMILScheduleEnum.defaultAwait,
				0,
			];

			for (let i = 0; i < testSchedules.length; i += 1) {
				const response = setDefaultAwait(testSchedules[i]);
				expect(response).to.be.equal(awaitTimes[i]);
			}
		});
	});

	describe('Playlist tools component runEndlessLoop, disableLoop tests', () => {
		it('Should stop endless loop after given amount of time', async () => {
			const sos: SosModule = {
				fileSystem: 'notSet',
				video: 'notSet',
			};
			const files = new Files(sos);
			const playlist = new Playlist(sos, files);
			const interval = 1000;
			const start = Date.now();
			await playlist.runEndlessLoop(async () => {
				await sleep(interval);
				playlist.disableLoop(true);
			});
			const end = Date.now();
			const timeWaited = end - start;
			expect(Math.abs(interval - timeWaited)).to.be.lessThan(50);
		});
	});

	describe('Playlist tools component setDuration', () => {
		it('Should return correct duration for various inputs', async () => {
			const durationStrings = [
				`999`,
				`indefinite`,
				'asdmaskd',
				'Nan',
				'200',
				undefined,
			];
			const duration = [
				999,
				999999,
				5,
				5,
				200,
				5,
			];

			for (let i = 0; i < durationStrings.length; i += 1) {
				const response = setElementDuration(<string> durationStrings[i]);
				expect(response).to.be.equal(duration[i]);
			}
		});
	});

	describe('Playlist tools component extractAdditionalInfo', () => {
		it('Should return correct values for additional parameters', async () => {
			let testImage: any = {
				src: 'http://butikstv.centrumkanalen.com/play/media/filmer/likabehandlingsdag2020.mp4',
				region: 'video',
				dur: '20',
				localFilePath: 'localFilePath',
				playing: false,
				fit: 'fill',
				regionInfo : {
					regionName: 'video',
					left: 0,
					top: 0,
					width: 0,
					height: 0,
					'z-index': 1,
					fit: 'fill',
				},
			};

			testImage = extractAdditionalInfo(testImage);

			expect(testImage.regionInfo.hasOwnProperty('fit')).to.be.equal(true);
		});
	});

	describe('Playlist tools component isNotPrefetchLoop', () => {
		it('Should detect infinite loops correctly', async () => {
			let testObject: any = {
				seq: [{
					dur: '60s',
				}, {
					prefetch: [{
						src: 'http://butikstv.centrumkanalen.com/play/render/widgets/ebbapettersson/top/top.wgt',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/render/widgets/ebbapettersson/vasttrafik/vasttrafik_news.wgt',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/media/rendered/bilder/ebbalunch.png',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/media/rendered/bilder/ebbaical.png',
					}],
				}],
			};

			let response = isNotPrefetchLoop(testObject);
			expect(response).to.be.equal(false);

			testObject = {
				par: [{
					dur: '60s',
				}, {
					prefetch: [{
						src: 'http://butikstv.centrumkanalen.com/play/render/widgets/ebbapettersson/top/top.wgt',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/render/widgets/ebbapettersson/vasttrafik/vasttrafik_news.wgt',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/media/rendered/bilder/ebbalunch.png',
					}, {
						src: 'http://butikstv.centrumkanalen.com/play/media/rendered/bilder/ebbaical.png',
					}],
				}],
			};

			response = isNotPrefetchLoop(testObject);
			expect(response).to.be.equal(false);

			testObject = {
				seq: {
					begin: '0',
					dur: 'indefinite',
					ref: {
						dur: 'indefinite',
						src: 'adapi:blankScreen',
					},
				},
			};

			response = isNotPrefetchLoop(testObject);
			expect(response).to.be.equal(false);

			testObject = {
				seq: {
					repeatCount: 'indefinite',
					img: {
						src: 'http://butikstv.centrumkanalen.com/play/media/rendered/bilder/ebbaical.png',
						region: 'widget14',
						dur: '60s',
						param: {
							name: 'cacheControl',
							value: 'onlyIfCached',
						},
					},
				},
			};

			response = isNotPrefetchLoop(testObject);
			expect(response).to.be.equal(true);

		});
	});

	describe('Playlist tools component extractDayInfo', () => {
		it('Should parse time string correctly', async () => {
			const testingStrings = [
				'2011-01-01T07:00:00',
				'2011-01-01+w3T07:00:00',
				'2011-01-01-w4T07:00:00',
				'2022-01-01T22:00:00',
			];

			const responses = [
				{
					timeRecord: '2011-01-01T07:00:00',
					dayInfo: '',
				},
				{
					timeRecord: '2011-01-01T07:00:00',
					dayInfo: '+w3',
				},
				{
					timeRecord: '2011-01-01T07:00:00',
					dayInfo: '-w4',
				},
				{
					timeRecord: '2022-01-01T22:00:00',
					dayInfo: '',
				},
			];

			for (let i = 0; i < testingStrings.length; i += 1) {
				const {timeRecord, dayInfo} = extractDayInfo(testingStrings[i]);
				expect(timeRecord).to.be.equal(responses[i].timeRecord);
				expect(dayInfo).to.be.equal(responses[i].dayInfo);
			}
		});
	});

	describe('Playlist tools component parseSmilSchedule tests', () => {
		it('Should return correct times for how long to wait and how long to play', async () => {
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01T07:00:00/P1D)
			let testStartString = `wallclock(R/${formatDate(moment())}/P1D)`;
			let testEndString = `wallclock(R/${formatDate(moment().add(4, 'hours'))}/P1D)`;
			let responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			// parse 2011-01-01T07:00:00 from wallclock(R/2011-01-01T07:00:00/P1D)
			expect(responseTimeObject.timeToEnd).to.eql(moment(testEndString.split('/')[1]).valueOf());

			testStartString = `wallclock(R/${formatDate(moment().subtract(2, 'hours'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().add(4, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment(testEndString.split('/')[1]).valueOf());

			testStartString = `wallclock(R/${formatDate(moment().add(1, 'hours'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().add(6, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(3600000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment(testEndString.split('/')[1]).valueOf());

			testStartString = `wallclock(R/${formatDate(moment().add(1, 'day'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().add(1, 'day').add(6, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// schedule start for tommorow 24hours
			expect(Math.abs(86400000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment(testEndString.split('/')[1]).valueOf());

			testStartString = `wallclock(R/${formatDate(moment().subtract(7, 'hours'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().subtract(4, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// schedule start for tommorow 17hours
			expect(Math.abs(61200000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment(testEndString.split('/')[1]).add(1, 'day').valueOf());

			testStartString = `wallclock(R/${formatDate(moment().subtract(15, 'days').subtract(7, 'hours'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().subtract(15, 'days').subtract(4, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// schedule start for tommorow 17hours
			expect(Math.abs(61200000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(responseTimeObject.timeToEnd - moment().add(1, 'day').subtract(4, 'hours').valueOf())).to.be.lessThan(1000);

			testStartString = `wallclock(R/${formatDate(moment().subtract(15, 'days').add(7, 'hours'))}/P1D)`;
			testEndString = `wallclock(R/${formatDate(moment().subtract(15, 'days').add(12, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// schedule start in 7 hours
			expect(Math.abs(25200000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(responseTimeObject.timeToEnd - moment().add(12, 'hours').valueOf())).to.be.lessThan(1000);

			// no endTime specified tomorrow start
			testStartString = `wallclock(R/${formatDate(moment().subtract(7, 'hours'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString);
			// play immediately
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment('2100-01-01T00:00:00').valueOf());

			// no endTime specified in the future start startN
			testStartString = `wallclock(R/${formatDate(moment().add(7, 'days'))}/P1D)`;
			responseTimeObject = parseSmilSchedule(testStartString);
			// schedule start in 7 days from now
			expect(Math.abs(604800000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(responseTimeObject.timeToEnd).to.eql(moment('2100-01-01T00:00:00').valueOf());

			testStartString = `wallclock(2020-07-16T12:00)`;
			testEndString = `wallclock(2020-07-17T19:00)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// should be never played
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			// timeToEnd = -3600000, value of 1970-01-01T00:00:00 in millis
			expect(responseTimeObject.timeToEnd.valueOf()).to.be.lessThan(0);

			testStartString = `wallclock(2020-01-01T09:00)`;
			testEndString = `wallclock(2020-12-01T12:00)`;
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			// timeToEnd = value of 2020-12-01T12:00:00
			expect(responseTimeObject.timeToEnd).to.eql(moment('2020-12-01T12:00:00').valueOf());

		});
		it('Should return correct times for how long to wait and how long to play - weekdays specified after', async () => {
			let mediaDuration = 3;
			let dayOfWeek = moment().isoWeekday() + 3;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01+w3T07:00:00/P1D)
			let testStartString = formatWeekDate(`wallclock(R/${formatDate(moment())}/P1D)`, `+w${dayOfWeek}`);
			let testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(mediaDuration, 'hours'))}/P1D)`, `+w${dayOfWeek}`);
			let responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// scheduled in 3 days
			expect(Math.abs(259199003 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(3, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

			mediaDuration = 2;
			dayOfWeek = moment().isoWeekday() - 1;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01+w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment())}/P1D)`, `+w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(mediaDuration, 'hours'))}/P1D)`, `+w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// scheduled in  days 6
			expect(Math.abs(518400000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(6, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

			mediaDuration = 4;
			dayOfWeek = moment().isoWeekday();
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01+w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment())}/P1D)`, `+w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(mediaDuration, 'hours'))}/P1D)`, `+w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// scheduled immediately
			expect(Math.abs(responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

			mediaDuration = 3;
			dayOfWeek = Math.abs(moment().isoWeekday() - 5);
			let waitMilis = computeWaitInterval(moment().isoWeekday(), dayOfWeek);
			let waitDays = waitMilis / 86400000;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01+w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment())}/P1D)`, `+w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(mediaDuration, 'hours'))}/P1D)`, `+w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(waitMilis - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(waitDays, 'day').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd))
				.to.be.lessThan(1000);

			mediaDuration = 3;
			dayOfWeek = Math.abs(moment().isoWeekday() + 5) % 7;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01+w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment())}/P1D)`, `+w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(mediaDuration, 'hours'))}/P1D)`, `+w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// scheduled in  days 5
			expect(Math.abs(432000000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(5, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

		});

		it('Should return correct times for how long to wait and how long to play - weekdays specified before', async () => {
			let mediaDuration = 2;
			let dayOfWeek = moment().isoWeekday();
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01-w3T07:00:00/P1D)
			let testStartString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days'))}/P1D)`, `-w${dayOfWeek}`);
			let testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days').add(mediaDuration, 'hours'))}/P1D)`, `-w${dayOfWeek}`);
			let responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// should play immediately
			expect(responseTimeObject.timeToStart <= 0).to.be.eql(true);
			expect(Math.abs(moment().add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

			mediaDuration = 4;
			dayOfWeek = moment().isoWeekday() + 2;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01-w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days'))}/P1D)`, `-w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days').add(mediaDuration, 'hours'))}/P1D)`, `-w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// should play in 2 days
			expect(Math.abs(172800000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(2, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

			mediaDuration = 2;
			dayOfWeek = Math.abs(moment().isoWeekday() - 5);
			let waitMilis = computeWaitInterval(moment().isoWeekday(), dayOfWeek);
			let waitDays = waitMilis / 86400000;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01-w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days'))}/P1D)`, `-w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days').add(mediaDuration, 'hours'))}/P1D)`, `-w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			expect(Math.abs(waitMilis - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(waitDays, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd))
				.to.be.lessThan(1000);

			mediaDuration = 3;
			dayOfWeek = Math.abs(moment().isoWeekday() + 5) % 7;
			// convert date to ISO format, remove milliseconds => format to this string wallclock(R/2011-01-01-w3T07:00:00/P1D)
			testStartString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days'))}/P1D)`, `-w${dayOfWeek}`);
			testEndString = formatWeekDate(`wallclock(R/${formatDate(moment().add(28, 'days').add(mediaDuration, 'hours'))}/P1D)`, `-w${dayOfWeek}`);
			responseTimeObject = parseSmilSchedule(testStartString, testEndString);
			// should play in 5 days
			expect(Math.abs(432000000 - responseTimeObject.timeToStart)).to.be.lessThan(1000);
			expect(Math.abs(moment().add(5, 'days').add(mediaDuration, 'hours').valueOf() - responseTimeObject.timeToEnd)).to.be.lessThan(1000);

		});
	});
});
