import {
  captureDomain,
  domainSchema,
  isDenseDomainArray,
} from "./domain-capture";
import {
  isCanonicalConfigurationPath,
  isLiteralConfigurationSegment,
} from "./domain-paths";
import { captureServiceData } from "./service-data-boundary";

export const canonicalConfigurationPathSchema = domainSchema<string, string>(
  (input) => captureDomain(input, isCanonicalConfigurationPath),
  "Invalid canonical configuration path",
).brand<"CanonicalConfigurationPath">();

function nonemptySegments(
  value: unknown,
): value is readonly [string, ...string[]] {
  return (
    isDenseDomainArray(value, isLiteralConfigurationSegment) && value.length > 0
  );
}
export const relativeConfigurationPathSchema = domainSchema<
  unknown,
  readonly [string, ...string[]]
>((input) => {
  const captured = captureServiceData(input);
  return captured.success
    ? captureDomain(captured.value, nonemptySegments)
    : captured;
}, "Invalid relative configuration path");
