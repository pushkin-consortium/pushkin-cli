/**
 * React Static Boilerplate
 * https://github.com/kriasoft/react-static-boilerplate
 *
 * Copyright © 2015-present Kriasoft, LLC. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.txt file in the root directory of this source tree.
 */

import React from 'react';
import s from './styles.scss';
import * as b from 'react-bootstrap';
import Container from '../containers/container';

export default class AboutPage extends React.Component {
	render() {
		return (
			<Container {...this.props}>
				<div>
					<p>All about us.</p>
				</div>
			</Container>
		);
	}
}
