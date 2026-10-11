import { strict as assert } from 'node:assert';
import test from 'node:test';

import { BrainlightError, VielightDevice } from './index.js';
import type { VielightRandomParams, RandomSessionField } from './index.js';

const validRandomParams: VielightRandomParams = {
	duration: 5,
	frequency: { ranges: [{ min: 10 }] },
	power: { min: 1 }
};

test('random validation reports every invalid field with shared IDs', function () {
	const errors = VielightDevice.getRandomParamsValidationErrors({
		basename: 'invalid.name',
		duration: 0,
		frequency: { ranges: [{ min: 0, max: 10000, weight: -1 }, { min: 40, weight: 101 }], offPercentage: 101 },
		power: { min: 0, max: 141 },
		coupling: { min: -1, max: 101, distribution: 101 },
		abCoupling: { distribution: -1 }
	});
	assert.deepEqual(errors.map(function (error): RandomSessionField { return(error.field); }), [
		'basename', 'duration', 'power.min', 'power.max',
		'coupling.min', 'coupling.max', 'coupling.distribution', 'abCoupling.distribution',
		'frequency.offPercentage', 'frequency.ranges.0.weight', 'frequency.ranges.0.min', 'frequency.ranges.0.max',
		'frequency.ranges.1.weight'
	]);
	assert.ok(errors.every(function (error): boolean { return(BrainlightError.isInstance(error)); }));
	assert.throws(function (): void {
		VielightDevice.validateRandomParams({ ...validRandomParams, duration: 0 });
	}, function (error): boolean {
		return(BrainlightError.isInstance(error) && error.field === 'duration');
	});
});

test('error recognition works across duplicate library class copies', async function () {
	const duplicateURL = new URL('../errors.js?duplicate', import.meta.url).href;
	const duplicate: typeof import('../errors.js') = await import(duplicateURL);
	const error = new duplicate.BrainlightError('Invalid duration.', 'duration');
	assert.equal(error instanceof BrainlightError, false);
	assert.equal(BrainlightError.isInstance(error), true);
	assert.equal(BrainlightError.isInstance(new Error('Invalid duration.')), false);
	assert.equal(BrainlightError.isInstance(null), false);
	assert.equal(BrainlightError.isInstance({ field: 'duration', message: 'Invalid duration.' }), false);
});

test('random validation highlights reversed maxima and all zero weights', function () {
	const errors = VielightDevice.getRandomParamsValidationErrors({
		duration: 5,
		frequency: { ranges: [{ min: 20, max: 10, weight: 0 }, { min: 40, weight: 0 }] },
		power: { min: 10, max: 1 },
		coupling: { min: 20, max: 10 }
	});
	assert.deepEqual(errors.map(function (error): RandomSessionField { return(error.field); }), [
		'power.max', 'coupling.max', 'frequency.ranges.0.max',
		'frequency.ranges.0.weight', 'frequency.ranges.1.weight'
	]);
	assert.deepEqual(VielightDevice.getRandomParamsValidationErrors(validRandomParams), []);
});

test('random validation checks independent off percentages and rejects legacy off entries', function () {
	for (const offPercentage of [-1, 101, 0.5, NaN, Infinity]) {
		const args = { ...validRandomParams, frequency: { ranges: [{ min: 10 }], offPercentage } };
		assert.deepEqual(VielightDevice.getRandomParamsValidationErrors(args).map(error => error.field), ['frequency.offPercentage']);
		assert.throws(() => VielightDevice.generateRandomParams('test', args), /whole number from 0 through 100/);
	}
	for (const offPercentage of [0, 25, 100]) {
		assert.deepEqual(VielightDevice.getRandomParamsValidationErrors({
			...validRandomParams, frequency: { ranges: [{ min: 10 }], offPercentage }
		}), []);
	}
	const legacyArgs = {
		...validRandomParams,
		frequency: { ranges: [{ min: 10, off: true }] }
	};
	assert.deepEqual(VielightDevice.getRandomParamsValidationErrors(legacyArgs).map(error => error.field), ['frequency.ranges.0.off']);
});

test('off percentage disables modules independently of session-wide frequency', function (context) {
	let call = 0;
	context.mock.method(Math, 'random', () => (++call % 2 === 0 ? 0.75 : 0.25));
	const data = VielightDevice.generateRandomParams('test', {
		...validRandomParams,
		frequency: { ranges: [{ min: 10 }, { min: 40 }], offPercentage: 50 },
		power: { min: 1 }
	});
	assert.ok(data.modules.some(module => !module.active));
	assert.ok(data.modules.some(module => module.active));
	assert.ok(data.modules.every(module => module.active ? module.freq === 10 : module.freq === null));
});

test('invalid random sessions fail before device requests or events', async function () {
	let requestCount = 0;
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetch: async function (): Promise<Response> {
			requestCount++;
			return(new Response(''));
		}
	});
	device.on('run-random-start', function (): void {
		assert.fail('Invalid session must not start.');
	});
	await assert.rejects(device.runRandom({ ...validRandomParams, duration: 0 }), function (error): boolean {
		return(BrainlightError.isInstance(error) && error.field === 'duration');
	});
	await assert.rejects(device.runRandom({
		...validRandomParams,
		frequency: { ranges: [{ min: 10 }], offPercentage: 101 }
	}), function (error): boolean {
		return(BrainlightError.isInstance(error) && error.field === 'frequency.offPercentage');
	});
	assert.equal(requestCount, 0);
});

test('uses the supplied fetch to retrieve files', async function () {
	const requestedURLs: URL[] = [];
	const device = new VielightDevice({
		ip: '192.0.2.1:8080',
		fetch: async function (input): Promise<Response> {
			requestedURLs.push(input);
			return(new Response(JSON.stringify(['one.vnp0']), { status: 200 }));
		}
	});

	const files = await device.listFiles('vnp0');

	assert.deepEqual(files, ['one.vnp0']);
	assert.equal(requestedURLs.length, 1);
	assert.equal(requestedURLs[0]?.toString(), 'http://192.0.2.1:8080/getlistfile?msg=vnp0');
});

test('uses a fetch without response data for write-only requests', async function () {
	const requestedURLs: URL[] = [];
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetchCanReturnData: false,
		fetch: async function (input) {
			requestedURLs.push(input);
			return({
				ok: true,
				status: 200,
				text: async function (): Promise<string> {
					assert.fail('Write-only requests must not read response text.');
				},
				json: async function (): Promise<unknown> {
					assert.fail('Write-only requests must not read response JSON.');
				}
			});
		}
	});

	await device.stop();
	await device.deleteFile('old.vnp0');
	await device.runFile('run.vnp0', { waitForCompletion: false });

	assert.deepEqual(
		requestedURLs.map(function (url): string {
			return(url.toString());
		}),
		[
			'http://127.0.0.1/stop?msg=Stop+button+pressed',
			'http://127.0.0.1/deletefile?data=old.vnp0',
			'http://127.0.0.1/stop?msg=Stop+button+pressed',
			'http://127.0.0.1/filedatarun?data=run.vnp0',
			'http://127.0.0.1/run?msg=Run+button+pressed'
		]
	);
});

test('rejects result-reading requests when fetch cannot return data', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetchCanReturnData: false,
		fetch: async function () {
			return({
				ok: true,
				status: 200,
				text: async function (): Promise<string> {
					assert.fail('Successful requests must not read response text before rejecting.');
				},
				json: async function (): Promise<unknown> {
					assert.fail('Successful requests must not read response JSON before rejecting.');
				}
			});
		}
	});

	await assert.rejects(device.listFiles('vnp0'), /Cannot examine result because fetch cannot return data/);
});

test('runRandom reports upload and run events and removes listeners', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetch: async function (input): Promise<Response> {
			const requestURL = new URL(input);
			if (requestURL.pathname === '/getlistfile') {
				return(new Response('[]', { status: 200 }));
			}
			if (requestURL.pathname === '/activate') {
				return(new Response('SPT', { status: 200 }));
			}
			return(new Response('', { status: 200 }));
		}
	});
	const reportedEvents: string[] = [];
	const removedListenerID = device.on('run-random-start', function (): void {
		assert.fail('Removed listener was called.');
	});
	device.off(removedListenerID);
	device.on('run-random-start', function (event): void {
		assert.equal(event.fileCount, 1);
		reportedEvents.push('run-random-start');
	});
	device.on('run-random-upload-start-file', function (event): void {
		assert.equal(event.fileIndex, 1);
		reportedEvents.push('run-random-upload-start-file');
	});
	device.on('run-randomupload-finish-file', function (event): void {
		assert.equal(event.data.modules instanceof Array, true);
		reportedEvents.push('run-randomupload-finish-file');
	});
	device.on('run-random-run-start-file', function (): void {
		reportedEvents.push('run-random-run-start-file');
	});
	device.on('run-random-run-finish-file', function (): void {
		reportedEvents.push('run-random-run-finish-file');
	});

	await device.runRandom({
		duration: 1,
		frequency: { ranges: [{ min: 10 }] },
		power: { min: 1 }
	});

	assert.deepEqual(reportedEvents, [
		'run-random-start',
		'run-random-upload-start-file',
		'run-randomupload-finish-file',
		'run-random-run-start-file',
		'run-random-run-finish-file'
	]);
});

test('runRandom stops the device and rejects when its signal is aborted', async function () {
	const device = new VielightDevice({
		ip: '127.0.0.1',
		fetch: async function (input): Promise<Response> {
			const requestURL = new URL(input);
			if (requestURL.pathname === '/getlistfile') {
				return(new Response('[]', { status: 200 }));
			}
			if (requestURL.pathname === '/stop') {
				stopRequests++;
			}
			return(new Response('', { status: 200 }));
		}
	});

	const controller = new AbortController();
	let stopRequests = 0;
	device.on('run-random-run-start-file', function (): void {
		controller.abort();
	});

	await assert.rejects(
		device.runRandom({
			duration: 1,
			frequency: { ranges: [{ min: 10 }] },
			power: { min: 1 }
		}, { signal: controller.signal }),
		/Session stopped\./
	);
	assert.equal(stopRequests, 1);
});
