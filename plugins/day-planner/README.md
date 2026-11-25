# Day planner

Turns your calendar into a plan for the day.

- **Brief section**: today's events and free blocks (morning), tomorrow's first event and when
  to leave (evening), the week ahead (weekly).
- **Find time / book a slot**: up to three free slots for something you want to fit in. Booking
  goes through the calendar capability, which asks first.
- **Leave now**: for an event with a place that is not your home, a nudge `travel_minutes`
  before it. The time is fixed; there is no live traffic and no maps service.
- **Meeting prep**: an hour before a meeting with other people, what is remembered about them
  and related mail. Each source is optional and given five seconds.

It needs something that provides `calendar.events`. With nothing connected the status says
"No calendar is connected." and the brief section is empty. Documents are not searched yet:
no plugin offers that as a capability.
