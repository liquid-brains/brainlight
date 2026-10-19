import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
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

test('random session duration accepts whole minutes below 60 and defaults to one minute', function () {
	for (const sessionDuration of [0, 60, 1.5, NaN, Infinity]) {
		const args = { ...validRandomParams, sessionDuration };
		assert.deepEqual(VielightDevice.getRandomParamsValidationErrors(args).map(error => error.field), ['sessionDuration']);
		assert.throws(() => VielightDevice.generateRandomParams('test', args), /whole number from 1 through 59/);
	}

	const defaultData = VielightDevice.generateRandomParams('test', validRandomParams);
	assert.ok(defaultData.modules.every(module => module.activeRunTime === 1));
	for (const sessionDuration of [1, 59]) {
		const data = VielightDevice.generateRandomParams('test', { ...validRandomParams, sessionDuration });
		assert.ok(data.modules.every(module => module.activeRunTime === sessionDuration));
	}
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
	assert.ok(data.modules.every(module => module.active));
	assert.ok(data.modules.some(module => module.freq === 0 && module.power === 0));
	assert.ok(data.modules.some(module => module.freq === 10 && module.power === 1));
	assert.ok(data.modules.every(module => module.freq === 0 || module.freq === 10));
});

test('frequency range distribution preserves flattened sampling by default and when false', function (context) {
	context.mock.method(Math, 'random', () => 0.1);
	for (const frequency of [
		{ ranges: [{ min: 10, max: 13, weight: 20 }, { min: 40, max: 49, weight: 80 }] },
		{ ranges: [{ min: 10, max: 13, weight: 20 }, { min: 40, max: 49, weight: 80 }], distributeRanges: false }
	]) {
		const data = VielightDevice.generateRandomParams('test', { ...validRandomParams, frequency });
		assert.ok(data.modules.every(module => module.freq === 12));
	}
});

test('two-level frequency distribution selects weighted ranges then uniform inclusive frequencies', function (context) {
	let draws: number[] = [];
	context.mock.method(Math, 'random', () => draws.shift() ?? 0.5);
	for (const [rangeDraw, frequencyDraw, expected] of [
		[0, 0, 10],
		[0.199999, 0.999999, 13],
		[0.2, 0, 40],
		[0.999999, 0.999999, 49]
	] as const) {
		draws = [rangeDraw, frequencyDraw];
		const data = VielightDevice.generateRandomParams('test', {
			...validRandomParams,
			frequency: {
				ranges: [{ min: 10, max: 13, weight: 20 }, { min: 40, max: 49, weight: 80 }],
				distributeRanges: true
			}
		});
		assert.ok(data.modules.every(module => module.freq === expected));
	}
});

test('two-level frequency distribution respects zero and omitted weights and singleton ranges', function (context) {
	let draw = 0;
	context.mock.method(Math, 'random', () => draw);
	for (const [rangeDraw, expected] of [[0, 40], [0.49, 40], [0.5, 10], [0.999999, 10]] as const) {
		draw = rangeDraw;
		const data = VielightDevice.generateRandomParams('test', {
			...validRandomParams,
			frequency: {
				ranges: [{ min: 1, max: 9999, weight: 0 }, { min: 40 }, { min: 10 }],
				distributeRanges: true
			}
		});
		assert.ok(data.modules.every(module => module.freq === expected));
	}
});

test('two-level frequency distribution applies per channel and preserves disabled modules', function (context) {
	const draws = [0, 0];
	for (let index = 0; index < 12; index++) {
		draws.push(0.5, index % 2 === 0 ? 0.1 : 0.9, 0.999999, 0.5, 0.5);
	}
	context.mock.method(Math, 'random', () => draws.shift() ?? 0.5);
	const frequency = {
		ranges: [{ min: 10, max: 19 }, { min: 40, max: 49 }],
		distributeRanges: true,
		perChannel: true
	};
	const data = VielightDevice.generateRandomParams('test', { ...validRandomParams, frequency });
	assert.deepEqual(data.modules.map(module => module.freq), [19, 49, 19, 49, 19, 49, 19, 49, 19, 49, 19, 49]);
	const offData = VielightDevice.generateRandomParams('test', {
		...validRandomParams, frequency: { ...frequency, offPercentage: 100 }
	});
	assert.ok(offData.modules.every(module => module.freq === 0 && module.power === 0));
});

test('random validation rejects non-boolean range distribution settings', function () {
	const args = {
		...validRandomParams,
		frequency: { ...validRandomParams.frequency, distributeRanges: 'true' as unknown as boolean }
	};
	assert.deepEqual(VielightDevice.getRandomParamsValidationErrors(args).map(error => error.field), ['frequency.distributeRanges']);
	assert.throws(() => VielightDevice.generateRandomParams('test', args), /must be a boolean/);
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

async function createTestServer(listener: RequestListener): Promise<Server> {
	const server = createServer(listener);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');

	return(server);
}

function serverIP(server: Server): string {
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw(new Error('Test server did not bind to a TCP address.'));
	}

	return(`127.0.0.1:${address.port}`);
}

test('retrieves files through an HTTP server', async function () {
	const requestedURLs: string[] = [];
	await using server = await createTestServer(function (request, response): void {
		requestedURLs.push(request.url ?? '');
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(['one.vnp0']));
	});
	const device = new VielightDevice({
		ip: serverIP(server)
	});

	const files = await device.listFiles('vnp0');

	assert.deepEqual(files, ['one.vnp0']);
	assert.deepEqual(requestedURLs, ['/getlistfile?msg=vnp0']);
});

test('does not require response data for write-only requests', async function () {
	const requestedURLs: string[] = [];
	await using server = await createTestServer(function (request, response): void {
		requestedURLs.push(request.url ?? '');
		response.end();
	});
	const device = new VielightDevice({
		ip: serverIP(server),
		fetchCanReturnData: false
	});

	await device.stop();
	await device.deleteFile('old.vnp0');
	await device.runFile('run.vnp0', { waitForCompletion: false });

	assert.deepEqual(
		requestedURLs,
		[
			'/stop?msg=Stop+button+pressed',
			'/deletefile?data=old.vnp0',
			'/stop?msg=Stop+button+pressed',
			'/filedatarun?data=run.vnp0',
			'/run?msg=Run+button+pressed'
		]
	);
});

test('rejects result-reading requests when fetch cannot return data', async function () {
	const requestedURLs: string[] = [];
	await using server = await createTestServer(function (request, response): void {
		requestedURLs.push(request.url ?? '');
		response.setHeader('content-type', 'application/json');
		response.end('[]');
	});
	const device = new VielightDevice({
		ip: serverIP(server),
		fetchCanReturnData: false
	});

	await assert.rejects(device.listFiles('vnp0'), /Cannot examine result because fetch cannot return data/);
	assert.deepEqual(requestedURLs, ['/getlistfile?msg=vnp0']);
});

test('runRandom reports upload and run events and removes listeners', async function () {
	await using server = await createTestServer(function (request, response): void {
		const requestURL = new URL(request.url ?? '/', 'http://localhost');
		if (requestURL.pathname === '/getlistfile') {
			response.setHeader('content-type', 'application/json');
			response.end('[]');
			return;
		}
		if (requestURL.pathname === '/activate') {
			response.end('SPT');
			return;
		}
		response.end();
	});
	const device = new VielightDevice({
		ip: serverIP(server)
	});
	const reportedEvents: string[] = [];
	const removedListenerID = device.on('run-random-start', function (): void {
		assert.fail('Removed listener was called.');
	});
	device.off(removedListenerID);
	device.on('run-random-start', function (event): void {
		assert.equal(event.fileCount, 2);
		reportedEvents.push('run-random-start');
	});
	device.on('run-random-upload-start-file', function (event): void {
		assert.equal(event.fileCount, 2);
		reportedEvents.push('run-random-upload-start-file');
	});
	device.on('run-randomupload-finish-file', function (event): void {
		assert.equal(event.data.modules instanceof Array, true);
		assert.ok((event.data.modules as { activeRunTime: number }[]).every(module => module.activeRunTime === 5));
		reportedEvents.push('run-randomupload-finish-file');
	});
	device.on('run-random-run-start-file', function (): void {
		reportedEvents.push('run-random-run-start-file');
	});
	device.on('run-random-run-finish-file', function (): void {
		reportedEvents.push('run-random-run-finish-file');
	});

	await device.runRandom({
		duration: 2,
		sessionDuration: 5,
		frequency: { ranges: [{ min: 10 }] },
		power: { min: 1 }
	});

	assert.deepEqual(reportedEvents, [
		'run-random-start',
		'run-random-upload-start-file',
		'run-randomupload-finish-file',
		'run-random-upload-start-file',
		'run-randomupload-finish-file',
		'run-random-run-start-file',
		'run-random-run-finish-file',
		'run-random-run-start-file',
		'run-random-run-finish-file'
	]);
});

test('runRandom stops the device and rejects when its signal is aborted', async function () {
	let stopRequests = 0;
	let stopRequestReceived!: () => void;
	const stopRequestReceivedPromise = new Promise<void>(function (resolve): void {
		stopRequestReceived = resolve;
	});
	await using server = await createTestServer(function (request, response): void {
		const requestURL = new URL(request.url ?? '/', 'http://localhost');
		if (requestURL.pathname === '/getlistfile') {
			response.setHeader('content-type', 'application/json');
			response.end('[]');
			return;
		}
		if (requestURL.pathname === '/stop') {
			stopRequests++;
			stopRequestReceived();
		}
		response.end();
	});
	const device = new VielightDevice({
		ip: serverIP(server)
	});

	const controller = new AbortController();
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
	await stopRequestReceivedPromise;
	assert.equal(stopRequests, 1);
});

test('rejects requests that exceed the configured timeout', async function () {
	let responseFinished!: () => void;
	const responseFinishedPromise = new Promise<void>(function (resolve): void {
		responseFinished = resolve;
	});
	await using server = await createTestServer(function (_request, response): void {
		setTimeout(function (): void {
			response.end('[]');
			responseFinished();
		}, 50);
	});
	const device = new VielightDevice({
		ip: serverIP(server),
		requestTimeout: 10
	});

	await assert.rejects(device.listFiles('vnp0'), /Device request timed out after 0.01 seconds\./);
	await responseFinishedPromise;
});
