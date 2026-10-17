/** Parameter paths shared by validators and input surfaces; frequency entry indexes are zero-based. */
export type RandomSessionField =
	| 'basename'
	| 'duration'
	| 'sessionDuration'
	| 'frequency.ranges'
	| 'frequency.perChannel'
	| 'frequency.offPercentage'
	| `frequency.ranges.${number}.${'min' | 'max' | 'off' | 'weight'}`
	| 'power.min'
	| 'power.max'
	| 'power.perChannel'
	| 'coupling.min'
	| 'coupling.max'
	| 'coupling.distribution'
	| 'abCoupling.distribution';

const brainlightErrorType = Symbol.for('@liquid-brains/brainlight/BrainlightError');

export class BrainlightError extends Error {
	private readonly [brainlightErrorType] = true;

	public constructor(message: string, public readonly field: RandomSessionField) {
		super(message);
		this.name = 'BrainlightError';
	}

	/** Recognizes errors even when callers load another copy of the library. */
	public static isInstance(value: unknown): value is BrainlightError {
		return(
			typeof value === 'object' && value !== null &&
			brainlightErrorType in value && value[brainlightErrorType] === true &&
			'message' in value && typeof value.message === 'string' &&
			'field' in value && typeof value.field === 'string'
		);
	}
}
