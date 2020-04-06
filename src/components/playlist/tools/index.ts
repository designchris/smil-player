import Debug from 'debug';
import { RegionAttributes, RegionsObject } from '../../../models';
import * as _ from 'lodash';

export const debug = Debug('@signageos/smil-player:playlistModule');

let cancelFunction = false;

export function disableLoop(value: boolean) {
	cancelFunction = value;
}

export async function sleep(ms: number): Promise<object> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function runEndlessLoop(fn: Function) {
	while (!cancelFunction) {
		try {
			await fn();
		} catch (err) {
			debug('Error: %O occured during processing function %s', err, fn.name);
			throw err;
		}
	}
}

export function getRegionInfo(regionObject: RegionsObject, regionName: string): RegionAttributes {
	const regionInfo = _.get(regionObject.region, regionName, regionObject.rootLayout);
	debug('Getting region info: %O for region name: %O', regionInfo, regionName);
	return regionInfo;
}