## ADDED Requirements

### Requirement: Call list view
The system SHALL provide an authenticated admin page listing calls (most recent first) with time, caller number, language, duration, status, and a note excerpt.

#### Scenario: Staff opens the call list
- **WHEN** an authenticated staff member opens the admin root page
- **THEN** calls are listed newest first with language, duration, and a note excerpt

### Requirement: Call detail view
The system SHALL provide a call detail page showing the full speaker-attributed transcript in order and the structured note.

#### Scenario: Staff reviews a call
- **WHEN** staff opens a call detail page
- **THEN** the complete transcript and the full structured note are displayed

### Requirement: Admin authentication
Admin pages and the admin API SHALL require basic authentication with credentials from configuration.

#### Scenario: Unauthenticated access
- **WHEN** a request without valid credentials hits an admin page or admin API route
- **THEN** access is denied with 401
