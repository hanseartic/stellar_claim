import {BigNumber} from "bignumber.js";
import {Badge, Button, Card, Col, Input, Popover, Row, Switch, Tooltip} from "antd";
import {DeleteOutlined, FireOutlined, SendOutlined} from "@ant-design/icons";
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {
    faBalanceScaleLeft,
    faCoins, faHandHolding,
    faPeopleArrows, faSatelliteDish, faLink, faUnlink, faCommentDots, faDumpsterFire
} from '@fortawesome/free-solid-svg-icons';
import React, {useEffect, useState} from "react";
import {
    AccountResponse,
    BASE_FEE,
    Claimant,
    Horizon,
    Keypair,
    Memo,
    Networks,
    Operation,
    Server,
    ServerApi,
    TransactionBuilder
} from "stellar-sdk";
import {OfferCallBuilder} from "stellar-sdk/lib/offer_call_builder";
import URI from "urijs";
import StellarHelpers, {getStellarAsset} from "../StellarHelpers";
import useApplicationState from "../useApplicationState";
import {submitTransaction} from "./WalletHandling";

type BalanceLineAsset = Horizon.BalanceLineAsset;
type BalanceLineNative = Horizon.BalanceLineNative;
type BalanceLine = Horizon.BalanceLine;

export type AccountBalanceRecord = {
    account: AccountResponse,
    asset: string,
    balance: BigNumber,
    buyingLiabilities: BigNumber,
    sellingLiabilities: BigNumber,
    spendable: BigNumber,
};

export default function BalanceCard({balanceRecord}: {balanceRecord: AccountBalanceRecord}) {
    const {accountInformation, setAccountInformation, autoRemoveTrustlines, setAutoRemoveTrustlines} = useApplicationState();
    const {getSelectedNetwork, horizonUrl: fnHorizonUrl} = StellarHelpers();
    const [assetDemand, setAssetDemand] = useState(new BigNumber(0));
    const [burnRemovePopoverVisible, setBurnRemovePopoverVisible] = useState(false);
    const [canBurn, setCanBurn] = useState(false);
    const [canRemoveTrust, setCanRemoveTrust] = useState(false);
    const [destinationAccount, setDestinationAccount] = useState<AccountResponse>()
    const [destinationCanReceivePayment, setDestinationCanReceivePayment] = useState(false);
    const [destinationAccountId, setDestinationAccountId] = useState('')
    const [destinationAccountInvalid, setDestinationAccountInvalid] = useState(false)
    const [horizonUrl, setHorizonUrl] = useState(fnHorizonUrl().href);
    const [isBurn, setIsBurn] = useState(false);
    const [sendAmount, setSendAmount] = useState('')
    const [sendAmountInvalid, setSendAmountInvalid] = useState(false)
    const [sendAsClaimable, setSendAsClaimable] = useState(true);
    const [sendPopoverVisible, setSendPopoverVisible] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [transactionMemo, setTransactionMemo] = useState('');
    const [xdr, setXDR] = useState('');

    const collect = (offersCollection: ServerApi.CollectionPage<ServerApi.OfferRecord>): Promise<BigNumber> => {
        if (!offersCollection.records.length) return new Promise((resolve) => resolve(new BigNumber(0)));

        return offersCollection.next()
            .then(collect)
            .then(currentDemand => offersCollection.records
                .map(record => {
                    // amount:    amount of counter-asset the buyer is willing to spend
                    // price_r.n: price-numerator   => this amount of asset should cost the amount given in 'd'
                    // price_r.d: price-denominator => this amount of counter-asset is offered for the amount given in 'p'
                    const pricePerUnit = new BigNumber(record.price_r.d).div(new BigNumber(record.price_r.n));
                    return new BigNumber(record.amount).div(pricePerUnit);
                })
                .reduce((prev, current) => prev.add(current), currentDemand)
            );
    };

    const saveXDR = () => {

        const asset = getStellarAsset(balanceRecord.asset);
        const transactionBuilder = new TransactionBuilder(
            accountInformation.account!,
            {fee: BASE_FEE, networkPassphrase: Networks[getSelectedNetwork()]})
            .addMemo(Memo.text(transactionMemo.length>0?transactionMemo:'via balances.lumens.space'));
        if (sendAsClaimable) {
            const claimants = [
                new Claimant(
                    destinationAccount!.accountId(),
                    Claimant.predicateUnconditional()
                )
            ];
            if (destinationAccount?.id !== accountInformation.account!.id) {
                const claimBack = new Claimant(
                    accountInformation.account!.id,
                    Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(new BigNumber(1)
                        // .times(new BigNumber(60)) // a minute
                        // .times(new BigNumber(60)) // an hour
                        // .times(new BigNumber(24)) // a day
                        // .times(new BigNumber(7))  // a week
                        .toString())));
                claimants.push(claimBack);
            }
            transactionBuilder
            .addOperation(Operation.createClaimableBalance({
                amount: sendAmount,
                asset: asset,
                claimants: claimants,
            }))
        } else {
            transactionBuilder.addOperation(Operation.payment({
                destination: destinationAccount!.accountId(),
                amount: sendAmount,
                asset: asset,
            }));
        }
        if (autoRemoveTrustlines) {
            if (balanceRecord.balance.eq(sendAmount)) {
                transactionBuilder.addOperation(Operation.changeTrust({
                    asset: asset,
                    limit: '0',
                }))
            }
        }
        const transactionXDR = transactionBuilder
            .setTimeout(0)
            .build().toXDR();
        setXDR(transactionXDR);
    };

    const CBSwitchOverlay = <>
        Sending a claimable balance allows to send funds before the recipient has established a trust-line.<br />
        This can only be disabled for assets where the recipient already has a trust-line established (e.g. <b>XLM</b> by default).<br /><br />
        When sending a claimable balance – in addition to the provided recipient – your sending account will be added as a second recipient.
        This allows to claim back the asset(s) in case the recipient does not accept or claim the balance on their side.
    </>

    const burnRemovePopoverContent = () => {
        const asset = getStellarAsset(balanceRecord.asset);
        const tb = async () => {
            const transactionBuilder = new TransactionBuilder(
                accountInformation.account!,
                {fee: BASE_FEE, networkPassphrase: Networks[getSelectedNetwork()]})
                .addMemo(Memo.text(transactionMemo.length>0?transactionMemo:'via balances.lumens.space'))
                .setTimeout(0);

            if (isBurn) {
                transactionBuilder.addOperation(Operation.payment({
                    asset: asset,
                    destination: destinationAccountId,
                    amount: sendAmount,
                }));
            } else if (!balanceRecord.buyingLiabilities.isZero()) {
                // cancel the buy-offers for this asset
                await accountInformation.account?.offers({limit: 200})
                    .then(({records}) => { records
                        .filter(({buying}) => buying.asset_type !== 'native' && buying.asset_code === asset.code && buying.asset_issuer === asset.issuer)
                        .map(buyingCurrentAssetOffer => transactionBuilder.addOperation(Operation.manageBuyOffer({
                            buyAmount: '0',
                            buying: getStellarAsset(`${buyingCurrentAssetOffer.buying.asset_code}:${buyingCurrentAssetOffer.buying.asset_issuer}`),
                            offerId: buyingCurrentAssetOffer.id,
                            price: buyingCurrentAssetOffer.price_r,
                            selling: getStellarAsset(`${buyingCurrentAssetOffer.selling.asset_code??'native'}:${buyingCurrentAssetOffer.selling.asset_issuer}`),
                            }))
                        );
                    })
            }
            if (!isBurn || (balanceRecord.balance.eq(sendAmount) && autoRemoveTrustlines)) {
                transactionBuilder.addOperation(Operation.changeTrust({
                    asset: asset,
                    limit: '0',
                }));
            }
            return transactionBuilder;
        }
        const burnHint = <>
            By clicking the button below you will burn all of your spendable funds of this asset.<br /><br />
            If you only want to burn parts of the spendable funds, use the send-button <br/>
            and enter the following destination instead:<br/><br/>
            <pre>{asset.getIssuer()}</pre>

            <Row gutter={16}>
                <Col span='flex'>
            <Tooltip
                overlay='When sending all funds of an asset, the trustline can be removed. This will free up 0.5 XLM'>
                <Switch
                    defaultChecked={autoRemoveTrustlines}
                    onChange={setAutoRemoveTrustlines}
                    checked={autoRemoveTrustlines}
                    checkedChildren={<FontAwesomeIcon icon={faUnlink}/>}
                    unCheckedChildren={<FontAwesomeIcon icon={faLink}/>}
                />
            </Tooltip>
                </Col>
                <Col span='flex'>{autoRemoveTrustlines?'Remove':'Keep'} the <a href="https://developers.stellar.org/docs/issuing-assets/anatomy-of-an-asset/#trustlines" target="_blank" rel="noreferrer">trustline</a> if possible</Col>
            </Row>
        </>;

        const removeHint = <>
            By clicking the button below you will remove the trustline to this asset.<br/>
            This will free up 0.5 XLM from the reserve.
            {(()=>{if (!balanceRecord.buyingLiabilities.isZero()){
                return <Row>
                    There are open offers on SDEX to buy this asset.<br/>
                    In order to remove the trustline they will be cancelled.
                </Row>
            }})()}
        </>;
        return (
        <Card title={isBurn?'Burn spendable amounts of this asset':'Remove trustline for this asset'}>
            {isBurn?burnHint:removeHint}
            <Row gutter={16}>
                <Col flex={1}><Input
                    allowClear
                    maxLength={28}
                    onChange={e => setTransactionMemo(e.target.value)}
                    prefix={<Tooltip overlay='Enter a memo'><FontAwesomeIcon icon={faCommentDots}/></Tooltip>}
                    placeholder='via balances.lumens.space'
                    value={transactionMemo}
                /></Col>
            </Row>
            <Row gutter={16} justify='end'>
                <Col span='flex'>
        <Button
            loading={submitting}
            onClick={() => {
                tb().then(transactionBuilder => setXDR(transactionBuilder.build().toXDR()));
            }}
            icon={isBurn?<FireOutlined />:<DeleteOutlined />}
        >{sendAmount === '0'?'remove':'burn'}</Button>
                </Col>
            </Row>
        </Card>
        )
    };
    const sendPopoverContent = <>
        <Row>
            <Input
                allowClear
                onChange={e => setSendAmount(e.target.value)}
                placeholder={balanceRecord.spendable.toFormat()}
                prefix={<Tooltip overlay='Enter the amount to send'><FontAwesomeIcon icon={faCoins} /></Tooltip>}
                suffix={<Tooltip overlay='Send all spendable funds'><FontAwesomeIcon icon={faBalanceScaleLeft} onClick={() =>
                    setSendAmount(balanceRecord.spendable.toFormat())
                } /></Tooltip>}
                value={sendAmount}
                style={{borderColor:sendAmountInvalid?'red':undefined}}
            />
        </Row>
        <Row>
            <Input
                allowClear
                onChange={e => setDestinationAccountId(e.target.value)}
                placeholder={Keypair.random().publicKey()}
                prefix={<Tooltip overlay='Enter the recipient address'><FontAwesomeIcon icon={faPeopleArrows}/></Tooltip>}
                /*suffix={<Tooltip overlay='Click here to burn the asset'><FontAwesomeIcon icon={faDumpsterFire} onClick={() => { setDestinationAccountId(getStellarAsset(balanceRecord.asset).getIssuer()); }}/></Tooltip>}*/
                value={destinationAccountId}
                style={{borderColor:destinationAccountInvalid?'red':undefined, width: '42em'}}
            />
        </Row>
        {!isBurn ? <></> : <Row>
        Sending to the issuer account will burn the selected amount of this asset!
        </Row>}
        <Row>
            <Input
                allowClear
                maxLength={28}
                onChange={e => setTransactionMemo(e.target.value)}
                prefix={<Tooltip overlay='Enter a memo'><FontAwesomeIcon icon={faCommentDots}/></Tooltip>}
                placeholder='via balances.lumens.space'
                value={transactionMemo}
            />
        </Row>
        <Row style={{paddingTop: 5, paddingBottom: 5}}>
            <Col>
                <Tooltip
                    overlay={CBSwitchOverlay}>
                    <Switch
                        defaultChecked={sendAsClaimable}
                        disabled={!destinationCanReceivePayment && !isBurn}
                        onChange={setSendAsClaimable}
                        checked={sendAsClaimable}
                        checkedChildren={<FontAwesomeIcon icon={faHandHolding}/>}
                        unCheckedChildren={<SendOutlined />}
                    />
                </Tooltip>
            </Col>
            <Col>&nbsp;</Col>
            <Col>
                Send as <a href='https://developers.stellar.org/docs/glossary/claimable-balance/'
                   target="_blank"
                   rel="noreferrer">
                    claimable balance
                </a>
            </Col>
        </Row>
        {getStellarAsset(balanceRecord.asset).isNative() ? <></> : <Row gutter={16}>
            <Col>
                <Tooltip
                    overlay='When sending all funds of an asset, the trustline can be removed. This will free up 0.5 XLM'>
                    <Switch
                        defaultChecked={autoRemoveTrustlines}
                        onChange={setAutoRemoveTrustlines}
                        checked={autoRemoveTrustlines}
                        checkedChildren={<FontAwesomeIcon icon={faUnlink}/>}
                        unCheckedChildren={<FontAwesomeIcon icon={faLink}/>}
                    />
                </Tooltip>
            </Col>
            <Col>{autoRemoveTrustlines?'Remove':'Keep'} the <a href="https://developers.stellar.org/docs/issuing-assets/anatomy-of-an-asset/#trustlines" target="_blank" rel="noreferrer">trustline</a> when sending all funds</Col>
        </Row>}
        <Row style={{paddingTop: 5, paddingBottom: 5}}>
        <Button
            icon={<FontAwesomeIcon style={{marginRight: '0.3em'}} icon={isBurn?faDumpsterFire:faSatelliteDish} />}
            disabled={destinationAccountInvalid||destinationAccountId.length===0||sendAmountInvalid||!sendAmount}
            loading={submitting}
            onClick={() => saveXDR()}
        >{isBurn?'Burn':'Transfer'} funds</Button>
        </Row>
    </>;


    const handleSendPopoverVisibleChange = (visible: any) => {
        if (balanceRecord.spendable.isZero()) return;
        setSendPopoverVisible(visible);
    }
    const handleBurnRemovePopoverVisibleChange = (visible: any) => {
        setBurnRemovePopoverVisible(visible);
    }
    useEffect(() => {
        if (destinationAccount) {
            const asset = getStellarAsset(balanceRecord.asset);
            const sendSelf = destinationAccount.accountId() === accountInformation.account?.accountId();
            const shouldBurn = destinationAccount.id === asset.getIssuer();
            const canReceivePayment = !sendSelf && (asset.isNative()
                || !!destinationAccount.balances
                    .filter((b: BalanceLine): b is (BalanceLineAsset|BalanceLineNative) =>
                        b.asset_type !== 'liquidity_pool_shares'
                    )
                    .find(b =>
                        b.asset_type !== 'native'
                        && b.asset_code === asset.code
                        && b.asset_issuer === asset.issuer
                    )
                || shouldBurn
            );
            setIsBurn(shouldBurn);
            if (!canReceivePayment) {
                setSendAsClaimable(true);
            }
            if (shouldBurn) {
                setSendAsClaimable(false);
            }
            setDestinationCanReceivePayment(canReceivePayment);
        } else {
            setIsBurn(false);
            setDestinationCanReceivePayment(false);
            setSendAsClaimable(true);
        }
    }, [destinationAccount, accountInformation.account, balanceRecord.asset]);
    useEffect(() => {
        setHorizonUrl(fnHorizonUrl().href);
    }, [fnHorizonUrl]);
    useEffect(() => {
        if (xdr) {
            setSubmitting(true);
            submitTransaction(xdr, accountInformation.account!, horizonUrl, getSelectedNetwork())
                .then(() => {
                    return new Server(horizonUrl)
                        .loadAccount(accountInformation.account!.id)
                        .then(account => setAccountInformation({account: account}));
                })
                .then(() => setXDR(''))
                .then(() => {
                    setDestinationAccount(undefined);
                    setDestinationAccountId('');
                    setSendAmount('');
                    setSubmitting(false);
                    setSendPopoverVisible(false);
                    setBurnRemovePopoverVisible(false);
                });
        }
        // eslint-disable-next-line
    }, [xdr]);
    useEffect(() => {
        if (destinationAccountId.length > 0) {
            new Server(horizonUrl).loadAccount(destinationAccountId)
                .then(setDestinationAccount)
                .then(() => setDestinationAccountInvalid(false))
                .catch(() => {
                    setDestinationAccount(undefined);
                    setDestinationAccountInvalid(true);
                });
        } else {
            setDestinationAccount(undefined);
            setDestinationAccountInvalid(false);
        }
    }, [destinationAccountId, horizonUrl]);
    useEffect(() => {
        setSendAmountInvalid(false);
        if (sendAmount !== undefined && sendAmount !== '') {
            try {
                const send = new BigNumber(sendAmount.replace(',',''));
                if (send.greaterThan(balanceRecord.spendable) || send.lessThan('0.0000001')) {
                    setSendAmountInvalid(true);
                }
                if (send.decimalPlaces() > 7) {
                   setSendAmount(send.round(7, BigNumber.ROUND_UP).toFormat());
                }
            } catch (e) {
                setSendAmountInvalid(true);
            }
        }
    }, [balanceRecord.spendable, sendAmount]);
    useEffect(() => {
        setIsBurn(isBurn&&!sendAmountInvalid)
    }, [isBurn, sendAmountInvalid])
    useEffect(() => {
        if (balanceRecord.asset !== 'native:XLM') {
            new OfferCallBuilder(new URI(horizonUrl))
                .buying(getStellarAsset(balanceRecord.asset))
                .limit(200)
                .call()
                .then(collect)
                .then(demand => setAssetDemand(demand.round(demand.lt(1)?7:0)))
        }
        setCanBurn(!balanceRecord.spendable.isZero());
        setCanRemoveTrust(balanceRecord.spendable.isZero()
            && balanceRecord.balance.isZero()
        );
        // eslint-disable-next-line
    }, []);

    let askOffset = 25;
    let bidOffset = 25;
    if (!assetDemand.isZero()) {
        bidOffset += 30;
        askOffset += 30;
    }
    if (!balanceRecord.sellingLiabilities.isZero()) askOffset += 30;
    return (<>
        <Badge.Ribbon
            color='red'
            style={{display: (balanceRecord.sellingLiabilities.isZero()?"none":""), marginTop: bidOffset}}
            text={balanceRecord.sellingLiabilities.isZero()?'':`Bid: ${balanceRecord.sellingLiabilities.toFormat()}`}>
            <Badge.Ribbon
                color='lime'
                style={{marginTop: askOffset, display: (balanceRecord.buyingLiabilities.isZero()?"none":"")}}
                text={balanceRecord.buyingLiabilities.isZero()?'':`Ask: ${balanceRecord.buyingLiabilities.toFormat()}`}>
                <Badge.Ribbon
                    color='blue'
                    style={{display: (assetDemand.isZero()?"none":""), marginTop: 25}}
                    text={assetDemand.isZero()?'':`Demand: ${assetDemand.toFormat()}`} >
                <Card size='small' title={balanceRecord.spendable.toFormat() + ' spendable'}>
                    <p>{balanceRecord.balance.sub(balanceRecord.spendable).toFormat()} reserved</p>
                    <b>{balanceRecord.balance.toFormat()} total</b>
                </Card>
            </Badge.Ribbon></Badge.Ribbon></Badge.Ribbon>
        <Row><Col flex={1}><Popover
            trigger="click"
            placement="bottomRight"
            visible={sendPopoverVisible}
            onVisibleChange={handleSendPopoverVisibleChange}
            content={sendPopoverContent}
            >
            <Button
                block
                disabled={balanceRecord.spendable.isZero()}
                icon={<SendOutlined />}
                onClick={() => {setSendAmount(''); setDestinationAccountId('');}}
                >Send
            </Button>
        </Popover></Col>
            {getStellarAsset(balanceRecord.asset).isNative()?<></>:
            <Col flex={1}><Popover
            trigger="click"
            content={burnRemovePopoverContent}
            onVisibleChange={handleBurnRemovePopoverVisibleChange}
            visible={burnRemovePopoverVisible}
            placement="bottomRight"
        >
            <Button
                block
                icon={!balanceRecord.spendable.isZero() ? <FireOutlined/> : <DeleteOutlined/>}
                disabled={!(canBurn || canRemoveTrust)}
                onClick={() => {
                    setDestinationAccountId(getStellarAsset(balanceRecord.asset).getIssuer());
                    setSendAmount(balanceRecord.spendable.toString(10));
                }}
            >{!balanceRecord.spendable.isZero()?'Burn':'Remove'}
            </Button>
        </Popover></Col>}</Row>
            </>);
}
