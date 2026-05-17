import { SkillBuilders } from "ask-sdk-core";
import {
  LaunchHandler,
  StartSleepHandler,
  StopSleepHandler,
  PauseSleepHandler,
  ResumeSleepHandler,
  LogNappyHandler,
  StartNursingHandler,
  SwitchSidesHandler,
  StopNursingHandler,
  LogBottleHandler,
  LogSolidsHandler,
  LastSleepHandler,
  LastFeedHandler,
  LastNappyHandler,
  HelpHandler,
  CancelStopHandler,
  FallbackHandler,
  SessionEndedHandler,
  ErrorHandler,
} from "./handlers.js";

const skill = SkillBuilders.custom()
  .addRequestHandlers(
    LaunchHandler,
    // Sleep
    StartSleepHandler,
    StopSleepHandler,
    PauseSleepHandler,
    ResumeSleepHandler,
    // Nappy
    LogNappyHandler,
    // Feed — nursing
    StartNursingHandler,
    SwitchSidesHandler,
    StopNursingHandler,
    // Feed — bottle & solids
    LogBottleHandler,
    LogSolidsHandler,
    // Queries
    LastSleepHandler,
    LastFeedHandler,
    LastNappyHandler,
    // Built-in
    HelpHandler,
    CancelStopHandler,
    FallbackHandler,
    SessionEndedHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .create();

export const handler = skill.invoke.bind(skill);
