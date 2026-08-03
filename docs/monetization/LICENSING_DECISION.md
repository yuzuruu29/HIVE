# Licensing decision record

Status: owner/legal decision unresolved. This document is product-engineering analysis, not legal advice.

## Current license

The repository contains the MIT License, copyright 2026 HIVE Contributors. In plain terms, it broadly permits use, copying, modification, distribution, sublicensing, and sale when the copyright and permission notice are retained; it disclaims warranty and liability. The license file was not changed by this work.

## Open-core implications

MIT supports adoption and commercial services, but it also permits third parties to redistribute modified or hosted versions. HIVE can sell implementation services and separately developed hosted features without restricting the Community runtime. Clean package, service, credential, and data boundaries are more dependable than runtime license checks for preserving that model.

## Separation considerations

- Keep Community code free of billing, account, and license-server imports.
- Put future proprietary hosted code in clearly identified packages or a separate repository after an explicit decision.
- Document source-availability and contribution expectations for mixed deployments.
- Review dependency licenses and contributor rights before distributing commercial bundles.

## Alternatives requiring approval

Possible future choices include retaining MIT for all code, using a separate proprietary license for hosted-only components, adopting a source-available license for selected new components, or changing the project license. Each changes contributor, customer, ecosystem, and enforcement implications and requires owner and qualified legal review. Existing contributor rights and prior releases cannot be assumed away.

## Recommendation

Retain MIT for the current Community runtime and monetize services first. Defer any license change until customer evidence identifies a concrete need. If proprietary hosted components are later approved, isolate them at the control-plane boundary and publish a precise repository/package policy.

## Unresolved decision

The owner must decide whether future hosted control-plane source is MIT, separately proprietary, or source-available, and obtain legal advice before changing licensing or accepting contributions under a new model.
