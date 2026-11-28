// SPDX-License-Identifier: AGPL-3.0-only
//! Running the limb as a service that starts with the device. P4-10 fills this in.

const NOT_YET: &str =
    "Installing the limb as a service is not available yet. Run `alexia-limb run` instead.";

/// Start the limb with the device, from now on.
pub fn install() -> Result<(), String> {
    Err(NOT_YET.into())
}

/// Stop starting the limb with the device.
pub fn uninstall() -> Result<(), String> {
    Err(NOT_YET.into())
}
