import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** Returns the number in E.164 format (e.g. +14155552671), or null if it is not a valid number. */
export function normalizeToE164(phone: string, defaultCountry: CountryCode = 'US'): string | null {
  const parsed = parsePhoneNumberFromString(phone, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}
