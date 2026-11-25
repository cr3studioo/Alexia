# Tasks

Your to-dos and lists (tasks, shopping, anything you name), with due days and reminders tied
to a place or a person. Quick captures land here (`tasks.add`).

- **Days** are ISO (`YYYY-MM-DD`) only. Turning "Friday" into a day is the assistant's job.
- **Due tasks** reach the scheduler as notices (that day at 18:00, or overdue).
- **Place reminders** ("when I'm at the gym") fire when whatever provides `context.current`
  reports an arrival at that place within the last 15 minutes. With no such provider they wait.
  They are only as good as the place events your phone sends.
- **Person reminders** ("next time I talk to Petr") fire when `memory.recall` for that name
  reports a mention in the last 10 minutes. **Limit:** memory's `recall` does not take a
  `since` argument or report times today, so it cannot say that; until it does, person
  reminders are not raised live. They are listed in the morning brief instead, until done.
- **Done is the end.** There is no delete tool.
- Brief: morning lists what is due or overdue and waiting person reminders; weekly lists the
  week's due tasks and how long the shopping list is.
