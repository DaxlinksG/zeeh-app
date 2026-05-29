/**
 * Beneficiary Store — saved send-to contacts for a Zeeh user
 *
 * Table: zeeh-beneficiaries  (PK: user_id, SK: beneficiary_id)
 *
 * A beneficiary is always another Zeeh user. The relationship is directional
 * and per-pair: A saving B does NOT give B permission to send to A without
 * also adding A to B's list.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' });
const db     = DynamoDBDocumentClient.from(client);

const TABLE = process.env.BENEFICIARIES_TABLE ?? 'zeeh-beneficiaries';

export interface Beneficiary {
  user_id:        string;  // the owner (sender)
  beneficiary_id: string;  // the Zeeh user_id of the saved contact
  email:          string;
  first_name:     string;
  last_name:      string;
  added_at:       string;
}

// Add — throws ConditionalCheckFailedException if already saved
export async function addBeneficiary(
  userId: string,
  data:   Pick<Beneficiary, 'beneficiary_id' | 'email' | 'first_name' | 'last_name'>,
): Promise<void> {
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: {
      user_id:        userId,
      beneficiary_id: data.beneficiary_id,
      email:          data.email,
      first_name:     data.first_name,
      last_name:      data.last_name,
      added_at:       new Date().toISOString(),
    },
    ConditionExpression: 'attribute_not_exists(beneficiary_id)',
  }));
}

// List all saved beneficiaries for a user
export async function getBeneficiaries(userId: string): Promise<Beneficiary[]> {
  const { Items } = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));
  const items = (Items ?? []) as Beneficiary[];
  return items.sort((a, b) => a.first_name.localeCompare(b.first_name));
}

// True if beneficiaryId is in userId's list
export async function isBeneficiary(userId: string, beneficiaryId: string): Promise<boolean> {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { user_id: userId, beneficiary_id: beneficiaryId },
  }));
  return !!Item;
}

// Remove a single beneficiary
export async function removeBeneficiary(userId: string, beneficiaryId: string): Promise<void> {
  await db.send(new DeleteCommand({
    TableName: TABLE,
    Key: { user_id: userId, beneficiary_id: beneficiaryId },
  }));
}
