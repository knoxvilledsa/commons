// Shared by the contact Pages Function (contact.js) and the build that renders
// the contact form (src/lib/content.ts, getContactTopics()), so the longest
// topic the form can submit and the longest topic the Function accepts are
// one number and cannot drift apart. The leading underscore keeps Cloudflare
// Pages from routing this file.
//
// A committee/working-group option submits its full English label as the
// topic ("<name> committee", "<name> working group"). The Studio caps a
// committee or working-group name at CONTACT_NAME_MAX (studio/schemaTypes/
// committee.ts and workingGroup.ts); the longest suffix runnerNoun() can add
// is " working group" (14 characters), so 80 + 14 = 94 fits under 100 with
// room to spare. getContactTopics() also clamps any value to CONTACT_TOPIC_MAX
// itself, so a name that reaches Sanity some other way (an API write, a
// document saved before the cap existed) still produces a submittable value
// and never makes its committee uncontactable.
export const CONTACT_NAME_MAX = 80;
export const CONTACT_TOPIC_MAX = 100;
