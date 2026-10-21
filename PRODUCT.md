# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Python (FastAPI) + SQLite on the server; the Mini App itself is plain HTML/CSS/JS with no build step. Opened inside Telegram as a Mini App (WebApp) through a bot. For the MVP it is served from the developer's machine through a temporary cloudflared HTTPS tunnel.

## Users

Students of the Sevastopol branch of Lomonosov Moscow State University (Филиал МГУ в Севастополе). They open the app from Telegram on a phone, usually between classes or in the morning, to see what is next today and this week. Teachers and staff are out of scope for now.

## Product Purpose

A single place inside Telegram where a student sees their own group's timetable without navigating the university's schedule website. Success: the student opens the app and knows the next class, room, and teacher within a couple of seconds.

## Positioning

The official site (raspisanie.sev.msu.ru) is a desktop admin-style form: faculty → course → group, every visit. This app remembers who the student is through their Telegram account and opens straight to their own schedule.

## Operating Context

- Launched from a Telegram bot as a Mini App; runs inside Telegram's in-app webview on phones, mostly one-handed.
- Identity comes from Telegram (id, name, username, avatar) via validated `initData`.
- First launch asks for direction (направление / факультет), course, group when the course has more than one, and the student's real name.
- Schedule data is scraped from https://raspisanie.sev.msu.ru/time-table/group?type=0 (faculty → course → group form; a table of pairs per day with subject, type, room, teacher) and cached in SQLite.

## Capabilities and Constraints

- MVP scope: Telegram-bound account, onboarding, personal timetable (today / week), profile with ability to change group.
- Lesson pair times come from the source site (1 пара 09:00–10:30, 2 пара 10:40–12:10, 3 пара 12:55–14:25, 4 пара 14:35–16:05, …).
- Source marks lesson kinds as abbreviations in brackets (e.g. [лек], [пз], [сем]); some cells are cancellations ("Отмена с …").
- Database: SQLite.
- Open: other features beyond the timetable are to be decided by the owner after the MVP review.

## Brand Commitments

- Ground is pure black (dark theme) or pure white (light theme), with a soft dark-blue halo in the top-left corner (owner's explicit requirement, 2026-10-21; replaced the earlier all-navy look).
- Navigation: a floating bottom bar with three icon buttons — schedule, student clubs, profile; the active one is an inverted pill. Profile opens with a three-way control: settings, profile, friends.
- Design guidance comes from the taste-skill (design-taste-frontend), app-screen rules, style "true-black-flat"; see `.taste-skill/app/direction.json`.
- Simple, uncluttered interface: few buttons, nothing that makes the app confusing (owner's explicit requirement).
- Interface language: Russian.

## Evidence on Hand

- Real timetable data from the official schedule site.
- No logos or official brand assets provided; do not imitate the official MSU identity or present the app as an official university product.

## Product Principles

1. The student's own next class is the answer; everything else is secondary.
2. Ask once, remember forever: onboarding happens only on first launch.
3. Fewer controls over more features.
4. Data shown is the source's data; never invent lessons.
