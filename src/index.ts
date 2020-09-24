// declare const jQuery: any;
import { applyFetchPolyfill } from './polyfills/fetch';
applyFetchPolyfill();
import sos from '@signageos/front-applet';
import { IStorageUnit } from '@signageos/front-applet/es6/FrontApplet/FileSystem/types';
import { processSmil } from './components/xmlParser/xmlParse';
import { Files } from './components/files/files';
import { Playlist } from './components/playlist/playlist';
import { FileStructure, SMILEnums } from './enums';
import { SMILFile, SMILFileObject, SosModule } from './models';
import Debug from 'debug';
import { getFileName } from './components/files/tools';
import { sleep, resetBodyContent, errorVisibility } from './components/playlist/tools';
const files = new Files(sos);
const playlist = new Playlist(sos, files);

const debug = Debug('@signageos/smil-player:main');

async function main(internalStorageUnit: IStorageUnit, smilUrl: string, thisSos: SosModule) {
	const smilFile: SMILFile = {
		src: smilUrl,
	};
	let downloadPromises: Promise<Function[]>[] = [];

	// set smilUrl in files instance ( links to files might me in media/file.mp4 format )
	files.setSmilUrl(smilUrl);

	let smilFileContent: string = '';

	// wait for successful download of SMIL file, if download or read from internal storage fails
	// wait for one minute and then try to download it again
	while (smilFileContent === '') {
		try {
			// download SMIL file
			downloadPromises = await files.parallelDownloadAllFiles(internalStorageUnit, [smilFile], FileStructure.rootFolder);

			await Promise.all(downloadPromises);

			smilFileContent = await thisSos.fileSystem.readFile({
				storageUnit: internalStorageUnit,
				filePath: `${FileStructure.rootFolder}/${getFileName(smilFile.src)}`,
			});

			debug('SMIL file downloaded');
			downloadPromises = [];

		} catch (err) {
			debug('Unexpected error occurred during smil file download : %O', err);
			// allow error display only during manual start
			if (!sos.config.smilUrl) {
				errorVisibility(true);
			}
			await sleep(SMILEnums.defaultDownloadRetry * 1000);
		}
	}

	resetBodyContent();

	const smilObject: SMILFileObject = await processSmil(smilFileContent);
	debug('SMIL file parsed: %O', smilObject);

	// download and play intro file if exists ( image or video )
	if (smilObject.intro.length > 0) {
		await playlist.playIntro(smilObject, internalStorageUnit, smilUrl);
	} else {
		// no intro
		debug('No intro video found');
		downloadPromises = await files.prepareDownloadMediaSetup(internalStorageUnit, smilObject);
		await Promise.all(downloadPromises);
		debug('SMIL media files download finished');
		await playlist.manageFilesAndInfo(smilObject, internalStorageUnit, smilUrl);
	}

	debug('Starting to process parsed smil file');
	await playlist.processingLoop(internalStorageUnit, smilObject, smilFile);
}

async function startSmil(smilUrl: string) {
	const storageUnits = await sos.fileSystem.listStorageUnits();

	// reference to persistent storage unit, where player stores all content
	const internalStorageUnit = <IStorageUnit> storageUnits.find((storageUnit) => !storageUnit.removable);

	await files.createFileStructure(internalStorageUnit);

	debug('file structure created');

	while (true) {
		try {
			// enable internal endless loops for playing media
			playlist.disableLoop(false);
			// enable endless loop for checking files updated
			playlist.setCheckFilesLoop(true);
			await main(internalStorageUnit, smilUrl, sos);
			debug('one smil iteration finished');
		} catch (err) {
			debug('Unexpected error : %O', err);
			throw err;
		}

	}
}
// self invoking function to start smil processing if smilUrl is defined in sos.config via timings
(async() => {
	await sos.onReady();
	if (sos.config.smilUrl) {
		debug('sOS is ready');
		debug('Smil file url is: %s', sos.config.smilUrl);
		await startSmil(sos.config.smilUrl);
	}
})();

// get values from form onSubmit and start processing
const smilForm = <HTMLElement> document.getElementById('SMILUrlWrapper');
smilForm.onsubmit = async function (event: Event) {
	event.preventDefault();
	Debug.enable('@signageos/smil-player:*');
	// Debug.disable();
	const smilUrl = (<HTMLInputElement> document.getElementById('SMILUrl')).value;
	debug('Smil file url is: %s', smilUrl);
	await startSmil(smilUrl);
};
