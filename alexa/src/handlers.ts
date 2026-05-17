import type { HandlerInput, RequestHandler } from "ask-sdk-core";
import type { Response } from "ask-sdk-model";
import { getBabyId, getBabyName, insertEntry, getLastEntry } from "./supabase.js";
import { spokenTime, spokenDuration, minutesAgo } from "./time.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slot(input: HandlerInput, name: string): string | undefined {
  const req = input.requestEnvelope.request;
  if (req.type !== "IntentRequest") return undefined;
  const s = req.intent?.slots?.[name];
  // Check entity resolution first (for synonyms like diaper→nappy, pee→wee)
  const resolutions = s?.resolutions?.resolutionsPerAuthority;
  if (resolutions?.length) {
    const match = resolutions[0]?.values?.[0]?.value;
    if (match) return match.name;
  }
  return s?.value;
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

export const StartSleepHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "StartSleepIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (attrs.sleepStart) {
      return input.responseBuilder
        .speak(`Sleep timer is already running since ${spokenTime(attrs.sleepStart)}.`)
        .getResponse();
    }
    const now = new Date().toISOString();
    attrs.sleepStart = now;
    input.attributesManager.setSessionAttributes(attrs);
    return input.responseBuilder
      .speak(`Started sleep timer at ${spokenTime(now)}.`)
      .reprompt("Say stop sleep when the baby wakes up.")
      .getResponse();
  },
};

export const StopSleepHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "StopSleepIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (!attrs.sleepStart) {
      return input.responseBuilder
        .speak("No sleep timer is running. Say start sleep to begin.")
        .reprompt("Say start sleep to begin tracking sleep.")
        .getResponse();
    }
    const start = attrs.sleepStart as string;
    const end = new Date().toISOString();
    delete attrs.sleepStart;
    input.attributesManager.setSessionAttributes(attrs);

    const babyId = await getBabyId();
    const duration = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
    await insertEntry(babyId, "sleep", {
      type: "sleep",
      startTime: start,
      endTime: end,
      source: "alexa",
      notes: "Alexa",
    });
    return input.responseBuilder
      .speak(`Logged sleep from ${spokenTime(start)} to ${spokenTime(end)}, ${spokenDuration(duration)}.`)
      .getResponse();
  },
};

export const PauseSleepHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "PauseSleepIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (!attrs.sleepStart) {
      return input.responseBuilder.speak("No sleep timer is running.").getResponse();
    }
    attrs.sleepPaused = new Date().toISOString();
    input.attributesManager.setSessionAttributes(attrs);
    return input.responseBuilder
      .speak("Sleep timer paused. Say resume sleep when ready.")
      .reprompt("Say resume sleep to continue.")
      .getResponse();
  },
};

export const ResumeSleepHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "ResumeSleepIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (!attrs.sleepPaused) {
      return input.responseBuilder.speak("Sleep timer is not paused.").getResponse();
    }
    delete attrs.sleepPaused;
    input.attributesManager.setSessionAttributes(attrs);
    return input.responseBuilder
      .speak("Sleep timer resumed.")
      .reprompt("Say stop sleep when the baby wakes up.")
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Nappy (diaper)
// ---------------------------------------------------------------------------

export const LogNappyHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LogNappyIntent";
  },
  async handle(input) {
    const nappyType = slot(input, "nappyType") ?? "wet";
    const babyId = await getBabyId();
    const now = new Date().toISOString();

    // Map spoken terms to entry data
    let type: string;
    let spoken: string;
    if (nappyType === "dirty" || nappyType === "poo") {
      type = "dirty";
      spoken = "dirty";
    } else if (nappyType === "both" || nappyType === "wet and dirty") {
      type = "both";
      spoken = "wet and dirty";
    } else {
      // wet, wee, pee → wet
      type = "wet";
      spoken = "wet";
    }

    await insertEntry(babyId, "nappy", {
      type,
      timestamp: now,
      source: "alexa",
      notes: "Alexa",
    });
    const name = await getBabyName();
    return input.responseBuilder
      .speak(`Logged ${spoken} nappy for ${name}.`)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Feed — Nursing
// ---------------------------------------------------------------------------

export const StartNursingHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "StartNursingIntent";
  },
  async handle(input) {
    const side = slot(input, "side") ?? "both";
    const attrs = input.attributesManager.getSessionAttributes();
    const now = new Date().toISOString();
    attrs.nursingStart = now;
    attrs.nursingSide = side;
    input.attributesManager.setSessionAttributes(attrs);
    return input.responseBuilder
      .speak(`Started nursing on ${side} side at ${spokenTime(now)}.`)
      .reprompt("Say switch sides, or stop nursing when finished.")
      .getResponse();
  },
};

export const SwitchSidesHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "SwitchSidesIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (!attrs.nursingStart) {
      return input.responseBuilder.speak("No nursing session is active.").getResponse();
    }
    const current = attrs.nursingSide as string;
    const newSide = current === "left" ? "right" : "left";
    attrs.nursingSide = newSide;
    input.attributesManager.setSessionAttributes(attrs);
    return input.responseBuilder
      .speak(`Switched to ${newSide} side.`)
      .reprompt("Say stop nursing when finished.")
      .getResponse();
  },
};

export const StopNursingHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "StopNursingIntent";
  },
  async handle(input) {
    const attrs = input.attributesManager.getSessionAttributes();
    if (!attrs.nursingStart) {
      return input.responseBuilder.speak("No nursing session is active.").getResponse();
    }
    const start = attrs.nursingStart as string;
    const side = attrs.nursingSide as string;
    const end = new Date().toISOString();
    delete attrs.nursingStart;
    delete attrs.nursingSide;
    input.attributesManager.setSessionAttributes(attrs);

    const babyId = await getBabyId();
    const duration = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
    await insertEntry(babyId, "feed", {
      type: "breast",
      side,
      startTime: start,
      endTime: end,
      duration,
      timestamp: start,
      source: "alexa",
      notes: "Alexa",
    });
    const name = await getBabyName();
    return input.responseBuilder
      .speak(`Logged ${spokenDuration(duration)} breastfeed on ${side} side for ${name}.`)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Feed — Bottle
// ---------------------------------------------------------------------------

export const LogBottleHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LogBottleIntent";
  },
  async handle(input) {
    const amountStr = slot(input, "amount");
    const unitStr = slot(input, "unit") ?? "ml";
    const amount = amountStr ? parseFloat(amountStr) : undefined;

    const babyId = await getBabyId();
    const now = new Date().toISOString();

    // Convert oz to ml if needed (1 oz ≈ 30 ml)
    let amountMl = amount;
    if (amount && (unitStr === "ounce" || unitStr === "ounces" || unitStr === "oz")) {
      amountMl = Math.round(amount * 30);
    }

    await insertEntry(babyId, "feed", {
      type: "bottle",
      amount: amountMl,
      timestamp: now,
      source: "alexa",
      notes: "Alexa",
    });
    const name = await getBabyName();
    const amountPhrase = amountMl ? `${amountMl} ml bottle` : "bottle feed";
    return input.responseBuilder
      .speak(`Logged ${amountPhrase} for ${name}.`)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Feed — Solids
// ---------------------------------------------------------------------------

export const LogSolidsHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LogSolidsIntent";
  },
  async handle(input) {
    const food = slot(input, "food") ?? "solids";
    const babyId = await getBabyId();
    const now = new Date().toISOString();

    await insertEntry(babyId, "feed", {
      type: "solids",
      food,
      timestamp: now,
      source: "alexa",
      notes: `Alexa: ${food}`,
    });
    const name = await getBabyName();
    return input.responseBuilder
      .speak(`Logged ${food} for ${name}.`)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Queries — last entry
// ---------------------------------------------------------------------------

export const LastSleepHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LastSleepIntent";
  },
  async handle(input) {
    const babyId = await getBabyId();
    const entry = await getLastEntry(babyId, "sleep");
    if (!entry) return input.responseBuilder.speak("No sleep entries found.").getResponse();
    const ts = (entry._timestamp ?? entry.startTime ?? entry.timestamp) as string;
    return input.responseBuilder
      .speak(`Last sleep was ${minutesAgo(ts)}, at ${spokenTime(ts)}.`)
      .getResponse();
  },
};

export const LastFeedHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LastFeedIntent";
  },
  async handle(input) {
    const babyId = await getBabyId();
    const entry = await getLastEntry(babyId, "feed");
    if (!entry) return input.responseBuilder.speak("No feed entries found.").getResponse();
    const ts = (entry._timestamp ?? entry.timestamp) as string;
    const feedType = (entry.type as string) ?? "feed";
    return input.responseBuilder
      .speak(`Last ${feedType} was ${minutesAgo(ts)}, at ${spokenTime(ts)}.`)
      .getResponse();
  },
};

export const LastNappyHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "LastNappyIntent";
  },
  async handle(input) {
    const babyId = await getBabyId();
    const entry = await getLastEntry(babyId, "nappy");
    if (!entry) return input.responseBuilder.speak("No nappy entries found.").getResponse();
    const ts = (entry._timestamp ?? entry.timestamp) as string;
    const nappyType = (entry.type as string) ?? "nappy";
    return input.responseBuilder
      .speak(`Last nappy was ${nappyType}, ${minutesAgo(ts)}.`)
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Built-in intents
// ---------------------------------------------------------------------------

export const LaunchHandler: RequestHandler = {
  canHandle(input) {
    return input.requestEnvelope.request.type === "LaunchRequest";
  },
  async handle(input) {
    const name = await getBabyName();
    return input.responseBuilder
      .speak(
        `Welcome to Nestling. I can track sleep, feeds, and nappies for ${name}. What would you like to do?`,
      )
      .reprompt("Say start sleep, log a nappy, or ask for the last feeding.")
      .getResponse();
  },
};

export const HelpHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "AMAZON.HelpIntent";
  },
  handle(input) {
    return input.responseBuilder
      .speak(
        "You can say things like: start sleep, stop sleep, log a wet nappy, " +
          "log a poo nappy, start nursing, log a 120 ml bottle, " +
          "or ask for the last sleep, last feed, or last nappy.",
      )
      .reprompt("What would you like to do?")
      .getResponse();
  },
};

export const CancelStopHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return (
      req.type === "IntentRequest" &&
      (req.intent.name === "AMAZON.CancelIntent" || req.intent.name === "AMAZON.StopIntent")
    );
  },
  handle(input) {
    return input.responseBuilder.speak("Goodbye!").withShouldEndSession(true).getResponse();
  },
};

export const FallbackHandler: RequestHandler = {
  canHandle(input) {
    const req = input.requestEnvelope.request;
    return req.type === "IntentRequest" && req.intent.name === "AMAZON.FallbackIntent";
  },
  handle(input) {
    return input.responseBuilder
      .speak("Sorry, I didn't understand that. Try saying start sleep or log a nappy.")
      .reprompt("What would you like to do?")
      .getResponse();
  },
};

export const SessionEndedHandler: RequestHandler = {
  canHandle(input) {
    return input.requestEnvelope.request.type === "SessionEndedRequest";
  },
  handle(input) {
    return input.responseBuilder.getResponse();
  },
};

export const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(input: HandlerInput, error: Error): Response {
    console.error("Error:", error.message);
    return input.responseBuilder
      .speak("Sorry, something went wrong. Please try again.")
      .reprompt("What would you like to do?")
      .getResponse();
  },
};
