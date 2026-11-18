// Keep the renderer's existing import path while sharing the wire format with external clients.
export { parseQuestionPayload, optionValue, encodeAnswers } from '@ari/contracts/questions'
export type {
  QuestionOption,
  QuestionItem,
  AnswerValue,
  AnswerMap,
  QuestionPayload,
} from '@ari/contracts/questions'
