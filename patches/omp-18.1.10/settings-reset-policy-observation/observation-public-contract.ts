import {
	Settings,
	type ResetPolicySettingsObservation,
} from "@oh-my-pi/pi-coding-agent/config/settings";

function publicObservationContract(settings: Settings): void {
	const observation: ResetPolicySettingsObservation = settings.captureResetPolicySettingsObservation();
	observation.assertCurrent();
	observation.adoptNativeAutoRedeemSet("yes");
	observation.dispose();
}

declare const observation: ResetPolicySettingsObservation;
// @ts-expect-error Native adoption accepts only the two persisted consent values.
observation.adoptNativeAutoRedeemSet("unset");

// @ts-expect-error Every lifecycle operation is required by the public capability.
const missingDispose: ResetPolicySettingsObservation = {
	assertCurrent() {},
	adoptNativeAutoRedeemSet(_mode: "yes" | "no") {},
};

void [publicObservationContract, missingDispose];
