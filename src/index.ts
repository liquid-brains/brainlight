#! /usr/bin/env ts-node

import * as Vielight from './lib/neuropro/index.js';
import * as fs from 'fs';

function AssertNever(x: never): never {
	throw(new Error(`Unexpected value: ${x}`));
}

function nonEmptyString(value: string | undefined | null): string {
	if (value === undefined || value === null) {
		throw(new Error('Expected non-empty string'));
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw(new Error('Expected non-empty string'));
	}

	return(value);
}

function nonEmptyNumber(value: number | undefined | null, defaultValue?: number): number {
	if (value === undefined || value === null) {
		if (defaultValue !== undefined) {
			return(defaultValue);
		}

		throw(new Error('Expected non-empty number'));
	}
	if (typeof value !== 'number' || isNaN(value)) {
		if (defaultValue !== undefined) {
			return(defaultValue);
		}
		throw(new Error('Expected non-empty number'));
	}

	return(value);
}

function parseIntSafe(value: string | undefined | null): number {
	const parsed = parseInt(nonEmptyString(value), 10);
	if (isNaN(parsed) || !Number.isInteger(parsed)) {
		throw(new Error('Expected a valid integer'));
	}

	return(parsed);
}

type VielightCLIArgs = {
	command: 'list' | 'help'
} | {
	command: 'get' | 'save' | 'delete';
	filename: string;
} | {
	command: 'run';
	filenames: string[];
} | ({
	command: 'runRandom';
	preview: boolean;
} & Vielight.VielightRandomParams);
function parseArgs(args: string[]): VielightCLIArgs {
	if (args.length === 0) {
		return({ command: 'help' });
	}

	const command = args[0] as VielightCLIArgs['command'];

	switch (command) {
		case 'list':
		case 'help':
			return({ command: command });
		case 'get':
		case 'save':
		case 'delete':
			if (args.length < 2 || !args[1]) {
				throw new Error('Missing filename for get command');
			}
			return({ command: command, filename: args[1] });
		case 'run':
			if (args.length < 2) {
				throw new Error('Missing filenames for run command');
			}
			return({ command: 'run', filenames: args.slice(1) });
		case 'runRandom':
			let preview = false;
			const runRandomArgs: Partial<Vielight.VielightRandomParams> = {};
			let i = 1;
			while (i < args.length) {
				const arg = args[i];
				if (arg === '--basename') {
					i++;
					runRandomArgs.basename = nonEmptyString(args[i]);
				} else if (arg === '--duration') {
					i++;
					runRandomArgs.duration = parseIntSafe(args[i]);
				} else if (arg === '--freq') {
					i++;
					const freqParts = nonEmptyString(args[i]).split('/');
					if (freqParts.length === 1) {
						const frequencyRange = nonEmptyString(freqParts[0]).split('...');
						if (frequencyRange.length < 1 || frequencyRange.length > 2) {
							throw(new Error('Invalid format for --freq argument'));
						}
						runRandomArgs.freqMin = parseIntSafe(frequencyRange[0]);
						if (frequencyRange[1] !== undefined) {
							runRandomArgs.freqMax = parseIntSafe(frequencyRange[1]);
						}
					} else if (freqParts.length === 2) {
						const [freqMinStr, freqMaxStr] = freqParts;
						const frequencyRange = nonEmptyString(freqMinStr).split('...');
						const couplingRange = nonEmptyString(freqMaxStr).split('...');
						if (frequencyRange.length < 1 || frequencyRange.length > 2 || couplingRange.length < 1 || couplingRange.length > 2) {
							throw(new Error('Invalid format for --freq argument'));
						}
						runRandomArgs.freqMin = parseIntSafe(frequencyRange[0]);
						if (frequencyRange[1] !== undefined) {
							runRandomArgs.freqMax = parseIntSafe(frequencyRange[1]);
						}
						runRandomArgs.couplingMin = parseIntSafe(couplingRange[0]);
						if (couplingRange[1] !== undefined) {
							runRandomArgs.couplingMax = parseIntSafe(couplingRange[1]);
						}
					} else {
						throw new Error('Invalid format for --freq argument');
					}
				} else if (arg === '--power') {
					i++;
					const powerParts = nonEmptyString(args[i]).split('...');
					if (powerParts.length === 1 || powerParts.length === 2) {
						runRandomArgs.powerMin = parseIntSafe(powerParts[0]);
						runRandomArgs.powerMax = parseIntSafe(powerParts[1] ?? String(runRandomArgs.powerMin));
					} else {
						throw new Error('Invalid format for --power argument');
					}
				} else if (arg === '--coupling-on-distribution') {
					i++;
					runRandomArgs.couplingRandomDistribution = parseIntSafe(args[i]);
				} else if (arg === '--preview') {
					preview = true;
				} else {
					throw new Error(`Unknown argument: ${arg}`);
				}
				i++;
			}

			if (!runRandomArgs.duration || !runRandomArgs.freqMin || !runRandomArgs.powerMin) {
				throw(new Error('Missing required arguments for runRandom command'));
			}

			return({
				command: 'runRandom',
				preview: preview,
				...runRandomArgs as Vielight.VielightRandomParams
			});
		default:
			if (1+1===2) {
				return({ command: 'help' });
			}

			AssertNever(command);
	}
}

async function listFiles(device: Vielight.VielightDevice) {
	const files = await device.listFiles();
	console.log('Files:');

	for (const file of files) {
		console.log(`- ${file}`);
	}
}

async function getFile(device: Vielight.VielightDevice, filename: string) {
	const data = await device.getFile(filename);

	fs.writeFileSync(filename, JSON.stringify(data, null, 8), 'utf-8');
}

async function saveFile(device: Vielight.VielightDevice, filename: string) {
	const data = JSON.parse(fs.readFileSync(filename, 'utf-8'));
	await device.saveFile(filename, data);
}

async function deleteFile(device: Vielight.VielightDevice, filename: string) {
	await device.deleteFile(filename);
}

async function runFiles(device: Vielight.VielightDevice, filenames: string[]) {
	for (const filename of filenames) {
		await device.runFile(filename);
	}
}

async function runRandom(device: Vielight.VielightDevice, args: Vielight.VielightRandomParams) {
	await device.runRandom(args);
}

async function previewRandom(args: Vielight.VielightRandomParams) {
	const device = new Vielight.VielightDevice({ ip: '127.0.0.1' });

	const data = device['generateRandomParams']('preview', args);
	console.log(JSON.stringify(data, undefined, 8));
}

async function main(inputArgs: string[]) {
	const device = new Vielight.VielightDevice({ ip: '192.168.0.58' });

	const args = parseArgs(inputArgs);

	switch (args.command) {
		case 'list':
			await listFiles(device);
			break;
		case 'get':
			await getFile(device, args.filename);
			break;
		case 'save':
			await saveFile(device, args.filename);
			break;
		case 'delete':
			await deleteFile(device, args.filename);
			break;
		case 'run':
			await runFiles(device, args.filenames);
			break;
		case 'runRandom':
			if (args.preview) {
				await previewRandom(args);
			} else {
				await runRandom(device, args);
			}
			break;
		case 'help':
		default:
			console.log('Usage:');
			console.log('  list                 List all files on the device');
			console.log('  get <filename>       Get a file from the device');
			console.log('  save <filename>      Save a file to the device');
			console.log('  delete <filename>    Delete a file from the device');
			console.log('  run <filenames...>   Run a sequence of files on the device');
			console.log('  runRandom [--basename <string>] --duration <minutes> --freq <freqMin[...freqMax]>[/<couplingMin[...couplingMax]>] [--coupling-on-distribution <0...100>] --power <min[...max]>     Run a random sequence of files on the device');
			break;
	}
}

main(process.argv.slice(2)).then(function () {
	process.exit(0);
}, function (error) {
	console.error(error);
	process.exit(1);
});
