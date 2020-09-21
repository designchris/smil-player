import Debug from 'debug';
import { RegionAttributes, SMILMediaSingle } from '../../../models';
import { XmlTags } from '../../../enums';
export const debug = Debug('@signageos/smil-player:xmlParseModule');

export function containsElement(arr: SMILMediaSingle[], fileSrc: string): boolean  {
	return arr.filter(function (elem: SMILMediaSingle) {
		return elem.src === fileSrc;
	}).length > 0;
}

export function parseNestedRegions(value: RegionAttributes) {
	for (let [, innerValue] of Object.entries(<RegionAttributes> value.region)) {
		for (let [innerRegionKey, ] of Object.entries(<RegionAttributes> innerValue)) {
			// if top and left do not exist on nested region, set default value 0
			innerValue.top = innerValue.top || 0;
			innerValue.left = innerValue.left || 0;
			if (XmlTags.cssElementsPosition.includes(innerRegionKey)) {
				switch (innerRegionKey) {
					case 'width':
						if (innerValue.width.indexOf('%') > -1 ) {
							innerValue.width = Math.floor(value.width * parseInt(innerValue.width) / 100);
							break;
						}
						innerValue.width = parseInt(innerValue.width);
						break;
					case 'height':
						if (innerValue.height.indexOf('%') > -1 ) {
							innerValue.height = Math.floor(value.height * parseInt(innerValue.height) / 100);
							break;
						}
						innerValue.height = parseInt(innerValue.height);
						break;
					case 'left':
						if (innerValue.left.indexOf('%') > -1 ) {
							innerValue.left = Math.floor(value.width * parseInt(innerValue.left) / 100) + parseInt(String(value.left));
							break;
						}
						innerValue.left = parseInt(String(value.left)) + parseInt(innerValue.left) || 0;
						break;
					case 'top':
						if (innerValue.top.indexOf('%') > -1 ) {
							innerValue.top = Math.floor(value.height * parseInt(innerValue.top) / 100) + parseInt(String(value.top));
							break;
						}
						innerValue.top = parseInt(String(value.top)) + parseInt(innerValue.top) || 0;
						break;
					default:
					// unhandled attribute
				}
			}
		}
	}
}
